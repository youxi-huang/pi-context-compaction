import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { CompactionId, compactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import { createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session, type SessionEvent, SessionId, SessionSeq, SessionStore } from "@deepseek-ai/dsh-session";
import { validateStoredEvents } from "@deepseek-ai/dsh-session-persistence";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { hashCanonicalRecords } from "../../compaction-core/src/canonical.ts";
import { queryHistory } from "../../compaction-core/src/history.ts";
import { sourceText, validateNote } from "../../compaction-core/src/notes.ts";
import { dshHistorySnapshot } from "../src/codec.ts";
import { readDshHistory } from "../src/history.ts";
import * as SliceHistory from "../src/index.ts";

const id = SessionId("synthetic-session");
const user = (text: string) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
const note = (source: string, quote: string) => ({
	instructions: [],
	failedPaths: [],
	reasons: [],
	state: [{ text: "Synthetic fact.", sources: [source], quote }],
	nextSteps: [],
	files: [],
	gaps: [],
});
function events(text = "Synthetic decision: use port 4317."): SessionEvent[] {
	const session = Session.create(id);
	return [session.append("user/message", user(text), { surfaceOp: "append" })];
}

describe("DSH native history codec", () => {
	it("uses native seq IDs and the shared validators; source mutation changes the JCS hash", () => {
		const native = events();
		const snapshot = dshHistorySnapshot(id, native);
		expect(snapshot.entries[0].id).toBe("0");
		expect(validateNote(note("0", "use port 4317"), snapshot.entries)).toBeTruthy();
		expect(() => validateNote(note("1", "use port 4317"), snapshot.entries)).toThrow("CONTEXT_NOTE_SCOPE");
		expect(() => validateNote(note("0", "use port 1234"), snapshot.entries)).toThrow("CONTEXT_NOTE_QUOTE");
		expect(hashCanonicalRecords(dshHistorySnapshot(id, events("changed")).entries)).not.toBe(
			hashCanonicalRecords(snapshot.entries),
		);
		expect(() => dshHistorySnapshot(id, [{ ...native[0], seq: SessionSeq(1) }])).toThrow("HISTORY_SOURCE_INVALID");
	});
	it("keeps media and unknown events opaque and detects their changed native payload", () => {
		const session = Session.create(id);
		const native = [
			session.append(
				"user/message",
				createUserMessage({
					content: [{ type: "reasoning", text: "synthetic opaque content" }],
					source: { kind: "user" },
				}),
				{ surfaceOp: "append" },
			),
		];
		const snapshot = dshHistorySnapshot(id, native);
		expect(sourceText(snapshot.entries[0])).toBe("");
		expect(() => queryHistory(snapshot, { operation: "read", entryId: "0" })).toThrow("HISTORY_SCOPE_DENIED");
	});
	it("keeps cursors pinned across append and rejects same-ID mutation and other sessions", () => {
		const session = Session.create(id);
		const native = [
			session.append("user/message", user("Synthetic original ".repeat(3000)), { surfaceOp: "append" }),
		];
		const request = { operation: "read", entryId: "0" };
		const page = queryHistory(dshHistorySnapshot(id, native), request, 512);
		expect(page.cursor).toBeTruthy();
		native.push(session.append("user/message", user("Synthetic tail"), { surfaceOp: "append" }));
		const next = queryHistory(dshHistorySnapshot(id, native), { ...request, cursor: page.cursor }, 512);
		expect(next.entries[0].offset).toBe(page.entries[0].text.length);
		expect(() =>
			queryHistory(dshHistorySnapshot(id, events("changed")), { ...request, cursor: page.cursor }),
		).toThrow("HISTORY_CURSOR_INVALID");
		expect(() => queryHistory(dshHistorySnapshot("sibling", native), { ...request, cursor: page.cursor })).toThrow(
			"HISTORY_CURSOR_INVALID",
		);
	});
	it("proves the pinned host refuses an external required checkpoint event at the storage boundary", () => {
		const session = Session.create(id);
		// A declaration merge alone is not persistence support. Exercise an unknown external envelope.
		const unknown = { type: "slice/checkpoint", seq: SessionSeq(0), time: 1, data: { synthetic: true } };
		expect(() => validateStoredEvents(session.header, [unknown as unknown as SessionEvent])).toThrow(
			"unknown to this harness",
		);
	});
});

describe("DSH official JSONL persistence binding", () => {
	it("loads, detects a competing tool, unloads and reloads through the official registry", async () => {
		const root = await mkdtemp(join(tmpdir(), "slice-dsh-plugin-test-"));
		const ctx = new Context();
		try {
			await ctx.plugin(SessionStore).await();
			await ctx.plugin(Jsonl, { root, compression: "none" }).await();
			await ctx.plugin(SystemPrompt, {}).await();
			await ctx.plugin(ToolRuntime).await();
			const plugin = await ctx.plugin(SliceHistory).await();
			expect(ctx.tools.get("context_history")).toBeTruthy();
			expect(() => SliceHistory.apply(ctx)).toThrow("SLICE_TOOL_CONFLICT");
			await plugin.dispose();
			expect(ctx.tools.get("context_history")).toBeUndefined();
			await ctx.plugin(SliceHistory).await();
			expect(ctx.tools.schemas().filter((tool) => tool.name === "context_history")).toHaveLength(1);
		} finally {
			await ctx.fiber.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
	it("retrieves originals after two native replacements, non-monotonic surface seqs, and a cold reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "slice-dsh-test-"));
		async function mount() {
			const ctx = new Context();
			await ctx.plugin(SessionStore).await();
			await ctx.plugin(Jsonl, { root, compression: "none" }).await();
			return ctx;
		}
		let ctx = await mount();
		try {
			const session = ctx.sessions.create(id);
			await ctx.sessionPersistence.create(session.header);
			session.append("turn/start", { turn: 1 });
			session.append("step/start", { turn: 1, step: 1 });
			session.append(
				"system/message",
				{ turn: 1, step: 1, message: createSystemMessage("Synthetic system") },
				{ surfaceOp: "append" },
			);
			const original = session.append("user/message", user("Synthetic original: port 4317."), {
				surfaceOp: "append",
			});
			const tail = session.append("user/message", user("Synthetic retained tail"), { surfaceOp: "append" });
			session.append("step/end", { turn: 1, step: 1 });
			session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
			function replace(start: SessionSeq, end: SessionSeq, shadowedSeqs: SessionSeq[], label: string) {
				const compactionId = CompactionId(label);
				const opening = session.append("compaction/start", { compactionId, turn: null });
				const summary = [{ type: "text" as const, text: `Synthetic summary ${label}` }];
				const summaryEvent = session.append("compaction/summary", {
					compactionId,
					summary,
					shadowedRange: { start, end },
					shadowedSeqs,
					shadowedTokenCount: 100,
					provider: "synthetic",
					model: "scripted",
				});
				const replacement = session.append(
					"user/message",
					createUserMessage({ content: summary, source: compactCheckpointSource(compactionId) }),
					{
						surfaceOp: { op: "replace", startSeq: start, endSeq: end },
						sourceEventSeqs: [opening.seq, summaryEvent.seq, ...shadowedSeqs],
					},
				);
				session.append("compaction/end", { compactionId, turn: null });
				return replacement.seq;
			}
			const first = replace(original.seq, original.seq, [original.seq], "synthetic-first");
			expect(first).toBeGreaterThan(tail.seq);
			replace(first, tail.seq, [first, tail.seq], "synthetic-second");
			const request = { operation: "read", entryId: String(original.seq) };
			const before = await readDshHistory(
				ctx.sessions,
				ctx.sessionPersistence,
				session,
				request,
				new AbortController().signal,
			);
			expect(before.entries[0].text).toBe("Synthetic original: port 4317.");
			await ctx.fiber.dispose();
			ctx = await mount();
			// A fresh backend and detached session identity: the adapter must obtain all evidence from storage.
			const reopened = Session.create(id);
			const after = await readDshHistory(
				{ flush: async () => true },
				ctx.sessionPersistence,
				reopened,
				request,
				new AbortController().signal,
			);
			expect(after).toEqual(before);
			const summary = await readDshHistory(
				{ flush: async () => true },
				ctx.sessionPersistence,
				reopened,
				{ operation: "read", entryId: String(first) },
				new AbortController().signal,
			);
			expect(summary.entries[0].role).toBe("context");
		} finally {
			await ctx.fiber.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
	it("refuses missing durability or cancellation before opening storage", async () => {
		let opens = 0;
		const persistence = {
			open: async () => {
				opens++;
				throw new Error("must not open");
			},
		};
		const session = Session.create(id);
		await expect(
			readDshHistory({ flush: async () => false }, persistence, session, {}, new AbortController().signal),
		).rejects.toThrow("HISTORY_PERSISTENCE_REQUIRED");
		await expect(
			readDshHistory(
				{
					flush: async () => {
						throw new Error("synthetic flush failure");
					},
				},
				persistence,
				session,
				{},
				new AbortController().signal,
			),
		).rejects.toThrow("synthetic flush failure");
		await expect(
			readDshHistory(
				{ flush: async () => true },
				persistence,
				session,
				{},
				AbortSignal.abort(new Error("synthetic cancellation")),
			),
		).rejects.toThrow("synthetic cancellation");
		expect(opens).toBe(0);
	});
});
