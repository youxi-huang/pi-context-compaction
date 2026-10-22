import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type CompactionEntry,
	type ExtensionContext,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyReduction, reduceRecords } from "../../compaction-core/src/reduction.ts";
import { DEFAULT_MEMORY_CONFIG, type NoteBudget } from "../src/extensions/context-memory/config.ts";
import {
	CONTEXT_KEEP_NONE,
	CONTEXT_MEMORY_KIND,
	CONTEXT_MEMORY_VERSION,
	hashEntries,
} from "../src/extensions/context-memory/identity.ts";
import {
	checkpointLineage,
	type MemoryCheckpoint,
	type MemoryNote,
	renderNote,
} from "../src/extensions/context-memory/notes.ts";
import type { PreviewSession } from "../src/extensions/context-memory/preview/contracts.ts";
import { PreviewMemoryController } from "../src/extensions/context-memory/preview/controller.ts";
import { PreviewFailureStore } from "../src/extensions/context-memory/preview/failure-store.ts";
import { readPreparationSettings } from "../src/extensions/context-memory/preview/preparation.ts";
import {
	citedRole,
	projectSummary,
	RENDER_CANDIDATES,
	type RenderCandidate,
	type RenderingSwitch,
	renderingSwitch,
} from "../src/extensions/context-memory/preview/render-projection.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const SYSTEM_PROMPT = "Synthetic system prompt.";
const FIRST_REQUEST = "Keep the service on port 4317. Do not deploy to production.";
const LOG_RESULT = "first log line: port 4317 healthy\nsecond log line: retries exhausted on port 9090";

const model = {
	id: "preview-test",
	name: "Preview test",
	provider: "preview-test",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function assistant(text: string, calls: ToolCall[] = []): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "preview-test",
		model: "preview-test",
		content: [{ type: "text", text }, ...calls],
		stopReason: calls.length ? "toolUse" : "stop",
		timestamp: 1,
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

interface CheckpointOptions {
	id?: string;
	build?: string;
	/** Omit `noteBudget` entirely, as a checkpoint written before tiered budgets (v0.4.x format) does. */
	v04?: boolean;
	withLineage?: boolean;
}

const TEST_NOTE_BUDGET: NoteBudget = {
	version: 1,
	mode: "tiered",
	tier: 1,
	sourceTokens: 2000,
	previousTokens: 0,
	baseTokens: 2000,
	hardTokens: 6000,
};

/** A persisted session through the public read-only surface, as the preview tests use it. */
class Session implements PreviewSession {
	readonly header: SessionHeader;
	readonly entries: SessionEntry[] = [];
	readonly file: string;
	leafId: string | null = null;
	readonly root: string;
	private checkpoints = 0;
	constructor(root: string, id = "render-session") {
		this.root = root;
		this.file = join(root, `${id}.jsonl`);
		this.header = { type: "session", version: 3, id, timestamp, cwd: root };
		this.persist();
	}
	persist(): void {
		fs.writeFileSync(
			this.file,
			`${[this.header, ...this.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
	}
	getCwd() {
		return this.root;
	}
	getSessionDir() {
		return this.root;
	}
	getSessionId() {
		return this.header.id;
	}
	getSessionFile() {
		return this.file;
	}
	getLeafId() {
		return this.leafId;
	}
	getLeafEntry() {
		return this.entries.find((entry) => entry.id === this.leafId);
	}
	getEntry(id: string) {
		return this.entries.find((entry) => entry.id === id);
	}
	getLabel(_id: string) {
		return undefined;
	}
	getHeader() {
		return this.header;
	}
	getEntries() {
		return [...this.entries];
	}
	getTree() {
		return [];
	}
	getSessionName() {
		return undefined;
	}
	getBranch(fromId?: string): SessionEntry[] {
		let entry = this.getEntry(fromId ?? this.leafId ?? "");
		const branch: SessionEntry[] = [];
		while (entry) {
			branch.unshift(entry);
			entry = this.getEntry(entry.parentId ?? "");
		}
		return branch;
	}
	buildContextEntries() {
		return this.getBranch();
	}
	buildSessionProjection() {
		return buildSessionProjection(this.getBranch());
	}
	append(entry: SessionEntry): void {
		this.entries.push(entry);
		this.leafId = entry.id;
		this.persist();
	}
	user(id: string, text: string): void {
		this.append({
			type: "message",
			id,
			parentId: this.leafId,
			timestamp,
			message: { role: "user", content: text, timestamp: 2 },
		});
	}
	reply(id: string, text: string, calls: ToolCall[] = []): void {
		this.append({ type: "message", id, parentId: this.leafId, timestamp, message: assistant(text, calls) });
	}
	result(id: string, toolCallId: string, text: string): void {
		this.append({
			type: "message",
			id,
			parentId: this.leafId,
			timestamp,
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 1,
			},
		});
	}
	/** A valid preview checkpoint over everything so far, with the branch's lineage as a real commit renders it. */
	checkpoint(note: MemoryNote, options: CheckpointOptions = {}): CompactionEntry<MemoryCheckpoint> {
		this.checkpoints += 1;
		const branch = this.getBranch();
		const details: MemoryCheckpoint = {
			kind: CONTEXT_MEMORY_KIND,
			version: CONTEXT_MEMORY_VERSION,
			note,
			coveredThrough: this.leafId!,
			sourceHash: hashEntries(branch),
			snapshot: { sessionId: this.header.id, leafId: this.leafId, lastCheckpointId: null },
			writerModel: "preview-test/preview-test",
			chunkCount: 1,
			build: options.build ?? "stock-preview+test",
			...(options.v04 ? {} : { noteBudget: TEST_NOTE_BUDGET }),
		};
		const entry: CompactionEntry<MemoryCheckpoint> = {
			type: "compaction",
			id: options.id ?? `cp${this.checkpoints}`,
			parentId: this.leafId,
			timestamp,
			summary: renderNote(note, options.withLineage === false ? [] : checkpointLineage(branch)),
			firstKeptEntryId: CONTEXT_KEEP_NONE,
			tokensBefore: 2000,
			details,
			fromHook: true,
		};
		this.append(entry);
		return entry;
	}
	messages(): AgentMessage[] {
		return this.buildSessionProjection().messages;
	}
}

function note(partial: Partial<MemoryNote> = {}): MemoryNote {
	return {
		instructions: [],
		failedPaths: [],
		reasons: [],
		state: [{ text: "The service runs on port 4317.", sources: ["u1"] }],
		nextSteps: [],
		files: [],
		gaps: [],
		...partial,
	};
}

/** One early turn with a tool read, a checkpoint, then a later turn: the folding fixture. */
function compactedTwice(root: string): { session: Session; second: CompactionEntry<MemoryCheckpoint> } {
	const session = new Session(root);
	session.user("u1", FIRST_REQUEST);
	session.reply("a1", "Reading the log.", [
		{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/srv/app.log" } },
	]);
	session.result("r1", "t1", LOG_RESULT);
	session.reply("a2", "The log is read; the port stays 4317.");
	session.checkpoint(note());
	session.user("u2", "Now check the retry budget.");
	session.reply("a3", "The retry budget is exhausted on port 9090.");
	const second = session.checkpoint(
		note({
			failedPaths: [
				{
					text: "Deploying to production was ruled out.",
					sources: ["u1"],
					quote: "Do not deploy to production.",
				},
				{ text: "Retries on port 9090 are exhausted.", sources: ["a3"] },
			],
			reasons: [
				{
					text: "Port 4317 is the healthy endpoint.",
					sources: ["r1"],
					quote: "port 4317 healthy",
					supersedes: ["u1"],
				},
			],
			state: [{ text: "The service runs on port 4317.", sources: ["u1"] }],
			nextSteps: [{ text: "Report the retry budget.", sources: ["u2"] }],
			gaps: ["The deploy window is unknown."],
		}),
	);
	return { session, second };
}

function makeContext(session: Session): ExtensionContext {
	return {
		sessionManager: session,
		model,
		modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
		thinkingLevel: "off",
		getSystemPrompt: () => SYSTEM_PROMPT,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 2000, contextWindow: 128_000, percent: null }),
		hasUI: false,
		ui: { notify: vi.fn() },
		abort: vi.fn(),
	} as unknown as ExtensionContext;
}

let root: string;
let stores = 0;
beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "pi-preview-render-"));
	stores = 0;
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});

function controller(rendering?: RenderingSwitch) {
	stores += 1;
	return new PreviewMemoryController({
		config: { ...DEFAULT_MEMORY_CONFIG, noteRepair: false },
		failureStore: new PreviewFailureStore(join(root, `agent-${stores}`)),
		...(rendering ? { rendering } : {}),
	});
}

function on(...candidates: RenderCandidate[]): RenderingSwitch {
	return { enabled: true, candidates };
}

function summaryOf(messages: readonly AgentMessage[]): string {
	const restored = messages.filter((message) => message.role === "compactionSummary");
	expect(restored).toHaveLength(1);
	return (restored[0] as { summary: string }).summary;
}

function aborted(ctx: ExtensionContext): number {
	return (ctx.abort as ReturnType<typeof vi.fn>).mock.calls.length;
}

describe("previewRendering switch", () => {
	it("parses previewRendering like the previewPreparation switch: off by default, disabled when invalid", () => {
		const cases: [string | undefined, RenderingSwitch][] = [
			[undefined, { enabled: false, candidates: [] }],
			[JSON.stringify({}), { enabled: false, candidates: [] }],
			[JSON.stringify({ previewRendering: {} }), { enabled: false, candidates: [] }],
			[JSON.stringify({ previewRendering: { enabled: true } }), { enabled: true, candidates: [] }],
			[
				JSON.stringify({ previewRendering: { enabled: true, candidates: ["lineage-once", "lineage-once"] } }),
				{ enabled: true, candidates: ["lineage-once"] },
			],
			[
				JSON.stringify({ previewRendering: { enabled: "yes" } }),
				{ enabled: false, candidates: [], error: "invalid-config" },
			],
			[
				JSON.stringify({ previewRendering: { enabled: true, candidates: ["unknown-candidate"] } }),
				{ enabled: false, candidates: [], error: "invalid-config" },
			],
			[
				JSON.stringify({ previewRendering: { enabled: true, candidates: "lineage-once" } }),
				{ enabled: false, candidates: [], error: "invalid-config" },
			],
			["{ not json", { enabled: false, candidates: [], error: "invalid-config" }],
		];
		for (const [content, expected] of cases) {
			const agentDir = fs.mkdtempSync(join(tmpdir(), "pi-render-settings-"));
			if (content !== undefined) fs.writeFileSync(join(agentDir, "pi-context-memory.json"), content);
			expect(readPreparationSettings(agentDir).rendering).toEqual(expected);
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
		expect(renderingSwitch({ enabled: true, candidates: [...RENDER_CANDIDATES] })).toEqual({
			enabled: true,
			candidates: [...RENDER_CANDIDATES],
		});
	});
});

describe("projection (pure)", () => {
	it("returns the stored summary byte for byte with no candidate and leaves the stored bytes untouched", () => {
		const { session, second } = compactedTwice(root);
		const branch = session.getBranch();
		const stored = second.summary;
		expect(
			projectSummary({ summary: stored, note: second.details!.note, entryId: second.id, branch, candidates: [] }),
		).toBe(stored);
		for (const candidate of RENDER_CANDIDATES) {
			const before = JSON.stringify(session.getEntries());
			const projected = projectSummary({
				summary: stored,
				note: second.details!.note,
				entryId: second.id,
				branch,
				candidates: [candidate],
			});
			const again = projectSummary({
				summary: stored,
				note: structuredClone(second.details!.note),
				entryId: second.id,
				branch: structuredClone(branch),
				candidates: [candidate],
			});
			expect(again).toBe(projected);
			// The stored checkpoint keeps its rendering byte for byte (G7): nothing was rewritten.
			expect(JSON.stringify(session.getEntries())).toBe(before);
			expect(session.getEntry(second.id)).toMatchObject({ summary: stored });
			expect(fs.readFileSync(session.getSessionFile()!, "utf8")).toContain(JSON.stringify(stored).slice(1, -1));
		}
	});

	it("folds an old failed path or reason to its one-line fact with source IDs and keeps the newest in full", () => {
		const { session, second } = compactedTwice(root);
		const projected = projectSummary({
			summary: second.summary,
			note: second.details!.note,
			entryId: second.id,
			branch: session.getBranch(),
			candidates: ["folded-failed-paths"],
		});
		// Folded: sources u1 and r1 precede the previous checkpoint; quotation and supersedes text are gone.
		expect(projected).toContain("- Deploying to production was ruled out. [u1]");
		expect(projected).toContain("- Port 4317 is the healthy endpoint. [r1]");
		expect(projected).not.toContain('Exact source: "Do not deploy to production."');
		expect(projected).not.toContain('Exact source: "port 4317 healthy"');
		expect(projected).not.toContain("(supersedes: u1)");
		// The newest failed path cites a3, after the previous checkpoint: full rendering kept.
		expect(projected).toContain("- Retries on port 9090 are exhausted. [a3]");
		// State, instructions and next steps render in full as now; the tail sections are preserved.
		expect(projected).toContain("- The service runs on port 4317. [u1]");
		expect(projected).toContain("- Report the retry budget. [u2]");
		expect(projected).toContain("## Unresolved\n- The deploy window is unknown.");
		expect(projected).toContain("## priorCheckpoints");
	});

	it("does not fold when no previous checkpoint exists: the projection equals the stored summary", () => {
		const session = new Session(root);
		session.user("u1", FIRST_REQUEST);
		session.reply("a1", "Done.");
		const first = session.checkpoint(
			note({
				failedPaths: [{ text: "An early failed path.", sources: ["u1"], quote: "Do not deploy" }],
			}),
		);
		const projected = projectSummary({
			summary: first.summary,
			note: first.details!.note,
			entryId: first.id,
			branch: session.getBranch(),
			candidates: ["folded-failed-paths"],
		});
		expect(projected).toBe(first.summary);
	});

	it("folds repeated lineage state lines once, keeping the guidance and every anchor ID", () => {
		const session = new Session(root);
		session.user("u1", FIRST_REQUEST);
		session.reply("a1", "Done.");
		session.checkpoint(note());
		session.user("u2", "Continue.");
		session.reply("a2", "Continuing.");
		session.checkpoint(note());
		session.user("u3", "Continue again.");
		session.reply("a3", "Still continuing.");
		const third = session.checkpoint(note());
		const stored = third.summary;
		// Both lineage items repeat the same state sentence.
		expect(stored).toContain("- through a1: The service runs on port 4317.");
		expect(stored).toContain("- through a2: The service runs on port 4317.");
		const projected = projectSummary({
			summary: stored,
			note: third.details!.note,
			entryId: third.id,
			branch: session.getBranch(),
			candidates: ["lineage-once"],
		});
		expect(projected).toContain("- through a1: The service runs on port 4317.");
		expect(projected).toContain("- through a2: (state as above)");
		expect(projected).toContain("Earlier checkpoints on this branch, oldest first");
		expect(projected.length).toBeLessThan(stored.length);
		// The head and everything before the lineage section are byte-identical.
		expect(projected.startsWith(renderNote(third.details!.note))).toBe(true);
	});

	it("tags each cited source with the role of its record, computed from the records", () => {
		const { session, second } = compactedTwice(root);
		const projected = projectSummary({
			summary: second.summary,
			note: second.details!.note,
			entryId: second.id,
			branch: session.getBranch(),
			candidates: ["cited-roles"],
		});
		expect(projected).toContain("- The service runs on port 4317. [u1 (user)]");
		expect(projected).toContain("[r1 (tool)]");
		expect(projected).toContain("[a3 (assistant)]");
		expect(projected).toContain("[u2 (user)]");
		// The quotation and supersedes text stay: this candidate adds tokens, it removes nothing.
		expect(projected).toContain('Exact source: "port 4317 healthy"');
		expect(projected).toContain("(supersedes: u1)");
		expect(projected.length).toBeGreaterThan(second.summary.length);
	});

	it("computes role tags from the record, never from the note", () => {
		const { session } = compactedTwice(root);
		const byId = new Map(session.getBranch().map((entry) => [entry.id, entry]));
		expect(citedRole(byId.get("u1"))).toBe("user");
		expect(citedRole(byId.get("r1"))).toBe("tool");
		expect(citedRole(byId.get("a3"))).toBe("assistant");
		expect(citedRole(undefined)).toBe("unknown");
	});

	it("renders a v0.4.x-format checkpoint, written before tiered budgets, under every candidate", () => {
		const session = new Session(root);
		session.user("u1", FIRST_REQUEST);
		session.reply("a1", "Done.");
		session.checkpoint(note(), { build: "stock-preview+v0.4.2", v04: true, withLineage: false });
		session.user("u2", "Continue.");
		session.reply("a2", "Continuing.");
		const old = session.checkpoint(
			note({
				failedPaths: [{ text: "An early failed path.", sources: ["u1"], quote: "Do not deploy" }],
			}),
			{ build: "stock-preview+v0.4.2", v04: true },
		);
		expect(old.details!.noteBudget).toBeUndefined();
		for (const candidate of RENDER_CANDIDATES) {
			const projected = projectSummary({
				summary: old.summary,
				note: old.details!.note,
				entryId: old.id,
				branch: session.getBranch(),
				candidates: [candidate],
			});
			expect(projected.length).toBeGreaterThan(0);
			expect(projected).toContain("Context memory.");
			expect(projected).toContain(candidate === "cited-roles" ? "[u1 (user)]" : "[u1]");
		}
		// The guards accept the reopened v0.4.x session with a candidate active.
		const ctx = makeContext(session);
		const projected = controller(on("folded-failed-paths")).context(session.messages(), ctx);
		expect(aborted(ctx)).toBe(0);
		expect(summaryOf(projected)).toContain("- An early failed path. [u1]");
	});
});

describe("guards and wiring", () => {
	it("treats an off, invalid, absent and empty-candidates switch identically to today", () => {
		const { session } = compactedTwice(root);
		const stored = summaryOf(session.messages());
		const expected = JSON.stringify(session.messages());
		for (const rendering of [
			undefined,
			{ enabled: false, candidates: [] as RenderCandidate[] },
			{ enabled: false, candidates: [] as RenderCandidate[], error: "invalid-config" as const },
			{ enabled: true, candidates: [] as RenderCandidate[] },
		]) {
			const ctx = makeContext(session);
			const subject = controller(rendering);
			const projected = subject.context(session.messages(), ctx);
			expect(JSON.stringify(projected)).toBe(expected);
			expect(summaryOf(projected)).toBe(stored);
			subject.beforeRequest({ messages: projected }, ctx);
			expect(aborted(ctx)).toBe(0);
		}
	});

	it("substitutes the projection for the model, accepts its own output again and binds the payload to it", () => {
		const { session, second } = compactedTwice(root);
		const derived = projectSummary({
			summary: second.summary,
			note: second.details!.note,
			entryId: second.id,
			branch: session.getBranch(),
			candidates: ["folded-failed-paths"],
		});
		expect(derived).not.toBe(second.summary);
		const ctx = makeContext(session);
		const subject = controller(on("folded-failed-paths"));
		// First pass (`context`): Pi restores the stored bytes; the handler substitutes the projection.
		const first = subject.context(session.messages(), ctx);
		expect(summaryOf(first)).toBe(derived);
		// Second pass (`context_with_system`) sees the projection the first pass substituted.
		const secondPass = subject.context(structuredClone(first), ctx);
		expect(JSON.stringify(secondPass)).toBe(JSON.stringify(first));
		// Every other message is untouched; only the summary text changed.
		const original = session.messages();
		expect(first.filter((message) => message.role !== "compactionSummary")).toEqual(
			original.filter((message) => message.role !== "compactionSummary"),
		);
		// The payload carries the same derivation.
		subject.beforeRequest({ messages: first }, ctx);
		expect(aborted(ctx)).toBe(0);
		// A payload that lost the projection — stored rendering only — is refused.
		subject.beforeRequest({ messages: original }, ctx);
		expect(aborted(ctx)).toBe(1);
	});

	it("derives the projection equal from a fresh render and a reopen", () => {
		const { session } = compactedTwice(root);
		const candidates: RenderCandidate[][] = RENDER_CANDIDATES.map((candidate) => [candidate]);
		candidates.push([...RENDER_CANDIDATES]);
		for (const selected of candidates) {
			const ctx = makeContext(session);
			const fresh = JSON.stringify(controller(on(...selected)).context(session.messages(), ctx));
			// A reopen: the same persisted entries read into a fresh session, controller and failure store.
			const reopened = new Session(root, `reopen-${selected.join("-")}`);
			for (const entry of session.getEntries()) reopened.append(structuredClone(entry));
			const reopenedCtx = makeContext(reopened);
			const again = JSON.stringify(controller(on(...selected)).context(reopened.messages(), reopenedCtx));
			expect(again).toBe(fresh);
			expect(aborted(ctx)).toBe(0);
			expect(aborted(reopenedCtx)).toBe(0);
		}
	});

	it("refuses a tampered rendering at both check sites", () => {
		const { session } = compactedTwice(root);
		const subject = controller(on("folded-failed-paths"));
		const good = subject.context(session.messages(), makeContext(session));
		const tamper = (messages: AgentMessage[]): AgentMessage[] =>
			messages.map((message) =>
				message.role === "compactionSummary"
					? { ...message, summary: summaryOf(messages).replace("port 4317", "port 9090") }
					: message,
			);
		// In context: neither the stored bytes nor the derivation, so the request is aborted.
		const tamperedContext = makeContext(session);
		controller(on("folded-failed-paths")).context(tamper(session.messages()), tamperedContext);
		expect(aborted(tamperedContext)).toBe(1);
		// In the payload: a tampered projection is refused by the same derivation.
		const tamperedPayload = makeContext(session);
		controller(on("folded-failed-paths")).beforeRequest({ messages: tamper(good) }, tamperedPayload);
		expect(aborted(tamperedPayload)).toBe(1);
		// A missing summary is refused as before.
		const missing = makeContext(session);
		controller(on("folded-failed-paths")).context(
			session.messages().filter((message) => message.role !== "compactionSummary"),
			missing,
		);
		expect(aborted(missing)).toBe(1);
	});

	it("composes with the WP2 reduction: summary projected, tool result reduced, in an order that cannot matter", () => {
		// A checkpoint, then a consumed big tool read: reduction touches only the tool result,
		// the rendering projection only the compactionSummary message, so the two commute.
		const session = new Session(root);
		session.user("u1", FIRST_REQUEST);
		session.reply("a1", "Done.");
		session.checkpoint(note());
		session.user("u2", "Continue.");
		session.reply("a2", "Continuing.");
		const last = session.checkpoint(
			note({ failedPaths: [{ text: "An early failed path.", sources: ["u1"], quote: "Do not deploy" }] }),
		);
		session.user("u3", "Read the log again.");
		session.reply("a3", "Reading.", [
			{ type: "toolCall", id: "t2", name: "read", arguments: { path: "/srv/app.log" } },
		]);
		session.result("r2", "t2", `first log line: port 4317 healthy\n${"log line: local check ok\n".repeat(120)}`);
		session.reply("a4", "The log is read.");
		session.user("u4", "Summarize it.");
		session.reply("a5", "Summarized.");
		const both = new PreviewMemoryController({
			config: { ...DEFAULT_MEMORY_CONFIG, noteRepair: false },
			failureStore: new PreviewFailureStore(join(root, "agent-both")),
			reduction: { enabled: true },
			rendering: on("folded-failed-paths"),
		});
		const ctx = makeContext(session);
		const composed = both.context(session.messages(), ctx);
		expect(aborted(ctx)).toBe(0);
		const serialized = JSON.stringify(composed);
		expect(serialized).toContain("[reduced tool result]");
		expect(serialized).not.toContain("log line: local check ok");
		expect(summaryOf(composed)).toContain("- An early failed path. [u1]");
		expect(summaryOf(composed)).toBe(
			projectSummary({
				summary: last.summary,
				note: last.details!.note,
				entryId: last.id,
				branch: session.getBranch(),
				candidates: ["folded-failed-paths"],
			}),
		);
		// The same bytes as applying the rendering projection first and the reduction after it.
		const renderingOnly = controller(on("folded-failed-paths")).context(session.messages(), makeContext(session));
		const view = reduceRecords(session.getBranch(), undefined);
		expect(view.entries.map((entry) => entry.recordId)).toEqual(["r2"]);
		expect(JSON.stringify(applyReduction(renderingOnly, view))).toBe(serialized);
	});

	it("reports the switch and its candidates in status, content-free", () => {
		const { session } = compactedTwice(root);
		const ctx = makeContext(session);
		const active = controller(on("lineage-once")).status(ctx) as { rendering?: unknown };
		expect(active.rendering).toEqual({ enabled: true, candidates: ["lineage-once"] });
		const invalid = controller({ enabled: false, candidates: [], error: "invalid-config" }).status(ctx) as {
			rendering?: unknown;
		};
		expect(invalid.rendering).toEqual({ enabled: false, reason: "invalid-config" });
		const absent = controller().status(ctx) as { rendering?: unknown };
		expect(absent.rendering).toBeUndefined();
	});
});

/**
 * The WP3 offline measurement: per-request projection size of the latest checkpoint's summary at 1,
 * 10 and 40 checkpoints, per candidate, from a synthetic session in Z1's shape — constant facts,
 * growing lineage. Bytes are exact; tokens use Pi's four-characters-per-token scale on this ASCII
 * fixture. The fixture and every projection are deterministic, so the table is asserted exactly.
 */
describe("measurement", () => {
	function measuredSession(checkpoints: number): { session: Session; last: CompactionEntry<MemoryCheckpoint> } {
		const session = new Session(root, `measure-${checkpoints}`);
		session.user("u1", FIRST_REQUEST);
		session.reply("a1", "Reading the log.", [
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/srv/app.log" } },
		]);
		session.result("r1", "t1", LOG_RESULT);
		session.reply("a2", "The log is read; the port stays 4317.");
		const measured = note({
			instructions: [{ text: "Keep the service on port 4317.", sources: ["u1"], quote: "port 4317" }],
			failedPaths: [
				{ text: "Deploying to production was ruled out.", sources: ["u1"], quote: "Do not deploy to production." },
				{ text: "Retrying on port 9090 failed.", sources: ["r1"], quote: "retries exhausted on port 9090" },
			],
			reasons: [{ text: "Port 4317 is the healthy endpoint.", sources: ["r1"], quote: "port 4317 healthy" }],
			state: [
				{ text: "The service runs on port 4317.", sources: ["u1"] },
				{ text: "The log was read in full.", sources: ["r1"] },
				{ text: "No deploy has happened.", sources: ["u1"] },
			],
			nextSteps: [{ text: "Report the retry budget.", sources: ["u1"] }],
			files: [{ text: "/srv/app.log holds the service log.", sources: ["r1"] }],
		});
		let last: CompactionEntry<MemoryCheckpoint> | undefined;
		for (let index = 1; index <= checkpoints; index++) {
			last = session.checkpoint(measured, { id: `cp${index}` });
			if (index < checkpoints) {
				session.user(`u${index + 1}`, `Continue step ${index + 1}.`);
				session.reply(`a${index + 2}`, `Step ${index + 1} is done.`);
			}
		}
		return { session, last: last! };
	}

	const piTokens = (text: string) => Math.ceil(text.length / 4);

	it("measures each candidate's per-request projection bytes at 1, 10 and 40 checkpoints", () => {
		const table: Record<string, Record<string, { bytes: number; tokens: number }>> = {};
		for (const checkpoints of [1, 10, 40]) {
			const { session, last } = measuredSession(checkpoints);
			const branch = session.getBranch();
			const stored = last.summary;
			const row: Record<string, { bytes: number; tokens: number }> = {
				current: { bytes: Buffer.byteLength(stored, "utf8"), tokens: piTokens(stored) },
			};
			for (const candidate of RENDER_CANDIDATES) {
				const projected = projectSummary({
					summary: stored,
					note: last.details!.note,
					entryId: last.id,
					branch,
					candidates: [candidate],
				});
				row[candidate] = { bytes: Buffer.byteLength(projected, "utf8"), tokens: piTokens(projected) };
			}
			table[String(checkpoints)] = row;
			fs.rmSync(session.getSessionFile()!, { force: true });
		}
		// At one checkpoint there is no previous checkpoint and no lineage: reductions change nothing.
		expect(table["1"]["folded-failed-paths"]).toEqual(table["1"].current);
		expect(table["1"]["lineage-once"]).toEqual(table["1"].current);
		// Folding and lineage deduplication shrink the projection once lineage and older facts exist.
		for (const checkpoints of ["10", "40"]) {
			expect(table[checkpoints]["folded-failed-paths"].bytes).toBeLessThan(table[checkpoints].current.bytes);
			expect(table[checkpoints]["lineage-once"].bytes).toBeLessThan(table[checkpoints].current.bytes);
		}
		// Cited roles add tokens at every depth, as the plan expects; M7 judges the cost.
		for (const checkpoints of ["1", "10", "40"]) {
			expect(table[checkpoints]["cited-roles"].bytes).toBeGreaterThan(table[checkpoints].current.bytes);
		}
		// The exact deterministic table; the validation record quotes these numbers.
		expect(table).toEqual(EXPECTED_MEASUREMENT);
	});
});

const EXPECTED_MEASUREMENT = {
	"1": {
		current: { bytes: 728, tokens: 182 },
		"folded-failed-paths": { bytes: 728, tokens: 182 },
		"lineage-once": { bytes: 728, tokens: 182 },
		"cited-roles": { bytes: 791, tokens: 198 },
	},
	"10": {
		current: { bytes: 1860, tokens: 465 },
		"folded-failed-paths": { bytes: 1728, tokens: 432 },
		"lineage-once": { bytes: 1348, tokens: 337 },
		"cited-roles": { bytes: 1923, tokens: 481 },
	},
	"40": {
		current: { bytes: 2443, tokens: 611 },
		"folded-failed-paths": { bytes: 2311, tokens: 578 },
		"lineage-once": { bytes: 1547, tokens: 387 },
		"cited-roles": { bytes: 2506, tokens: 627 },
	},
};
