import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type JsonObject,
	type Model,
} from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	convertToLlm,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyReduction,
	DEFAULT_CACHE_LIFETIME_MS,
	declaredCacheLifetimeMs,
	type ReductionView,
	reduceRecords,
	reductionLine,
} from "../../compaction-core/src/reduction.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/extensions/context-memory/config.ts";
import { freezeHistory, queryHistory } from "../src/extensions/context-memory/history.ts";
import { CONTEXT_MEMORY_KIND, CONTEXT_NOTE_TYPE } from "../src/extensions/context-memory/identity.ts";
import type { MemoryNote } from "../src/extensions/context-memory/notes.ts";
import type { PreviewCompaction, PreviewSession } from "../src/extensions/context-memory/preview/contracts.ts";
import { assertPreviewSession, PreviewMemoryController } from "../src/extensions/context-memory/preview/controller.ts";
import { PreviewFailureStore } from "../src/extensions/context-memory/preview/failure-store.ts";
import { readPreparationSettings } from "../src/extensions/context-memory/preview/preparation.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const RESULT_MARKER = "first log line: port 4317 healthy";
/** A tool result large enough that the small turns following it satisfy the suffix trigger. */
const BIG_RESULT = `${RESULT_MARKER}\n${"log line: local check ok, port 4317 healthy\n".repeat(120)}`;
const SMALL_RESULT = `${RESULT_MARKER}\n${"x".repeat(400)}`;

function assistantStop(
	text = "The synthetic step is recorded.",
	stopReason: "stop" | "error" = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "preview-test",
		model: "preview-test",
		content: [{ type: "text", text }],
		stopReason,
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

function assistantCall(callId: string, name: string, args: JsonObject): AssistantMessage {
	return {
		...assistantStop(),
		content: [{ type: "toolCall", id: callId, name, arguments: args }],
		stopReason: "toolUse",
	};
}

function user(id: string, text: string, ts?: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: ts ?? timestamp,
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function reply(id: string, text?: string, ts?: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: ts ?? timestamp, message: assistantStop(text) };
}

function call(id: string, callId: string, name: string, args: JsonObject, ts?: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: ts ?? timestamp,
		message: assistantCall(callId, name, args),
	};
}

function result(
	id: string,
	callId: string,
	name: string,
	text: string,
	options?: { isError?: boolean; ts?: string },
): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: options?.ts ?? timestamp,
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: name,
			content: [{ type: "text", text }],
			isError: options?.isError ?? false,
			timestamp: 1,
		},
	};
}

function fact(sources: string[]): { text: string; sources: string[] } {
	return { text: "A synthetic recorded fact.", sources };
}

function checkpointRecord(id: string, sources: string[]): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp,
		summary: "Synthetic summary.",
		firstKeptEntryId: "none",
		tokensBefore: 0,
		details: {
			kind: CONTEXT_MEMORY_KIND,
			note: {
				instructions: [],
				failedPaths: [],
				reasons: [],
				state: [fact(sources)],
				nextSteps: [],
				files: [],
				gaps: [],
			},
		},
	};
}

function workNoteRecord(id: string, sources: string[]): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp,
		customType: CONTEXT_NOTE_TYPE,
		data: { state: [fact(sources)] },
	};
}

/** A linear branch: parent links rewritten in order, so pure-function tests need no session object. */
function chain(...entries: SessionEntry[]): SessionEntry[] {
	return entries.map((entry, index) => ({ ...entry, parentId: index ? entries[index - 1].id : null }));
}

/** u1, call, big result, completing stop, then one later finished turn: the standard R-B shape. */
function consumedRead(resultText = BIG_RESULT): SessionEntry[] {
	return chain(
		user("u1", "Keep the service on port 4317. Do not deploy."),
		call("a1", "call-1", "read", { path: "/srv/app.log" }),
		result("r1", "call-1", "read", resultText),
		reply("a2", "The log is read."),
		user("u2", "Summarize the log."),
		reply("a3", "Summarized."),
	);
}

const reducedIds = (view: ReductionView) => view.entries.map((entry) => entry.recordId);

describe("reduction view (pure)", () => {
	it("reduces a consumed tool result and derives the same bytes from the same records", () => {
		const records = consumedRead();
		const first = reduceRecords(records, undefined);
		const second = reduceRecords(structuredClone(records), undefined);
		expect(reducedIds(first)).toEqual(["r1"]);
		expect(first.tokensRemoved).toBeGreaterThan(0);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
	it("extends the reduced view monotonically and byte-stably as turns append", () => {
		const shorter = consumedRead();
		const longer = [
			...shorter,
			{ ...user("u3", "Continue checking."), parentId: "a3" },
			{ ...reply("a4", "Still checking."), parentId: "u3" },
		];
		const viewShort = reduceRecords(shorter, undefined);
		const viewLong = reduceRecords(longer, undefined);
		expect(viewLong.entries.slice(0, viewShort.entries.length)).toEqual([...viewShort.entries]);
		const shortMessages = applyReduction(buildSessionProjection([...shorter]).messages, viewShort);
		const longMessages = applyReduction(buildSessionProjection([...longer]).messages, viewLong);
		expect(JSON.stringify(longMessages.slice(0, shortMessages.length))).toBe(JSON.stringify(shortMessages));
	});
	it("keeps a tool result inside an unfinished request or the current turn", () => {
		const records = consumedRead();
		// No assistant stop after the result yet: the turn is unfinished.
		expect(reducedIds(reduceRecords(records.slice(0, 3), undefined))).toEqual([]);
		// One completing stop but no later finished turn: R-B is not yet proven.
		expect(reducedIds(reduceRecords(records.slice(0, 4), undefined))).toEqual([]);
		expect(reducedIds(reduceRecords(records, undefined))).toEqual(["r1"]);
	});
	it("keeps an unpaired tool result", () => {
		const records = consumedRead();
		const orphan = structuredClone(records);
		const entry = orphan[2];
		if (entry.type === "message" && entry.message.role === "toolResult") entry.message.toolCallId = "missing-call";
		expect(reducedIds(reduceRecords(orphan, undefined))).toEqual([]);
	});
	it("keeps sole-evidence entries full when the citation precedes eligibility", () => {
		const [u1, a1, r1, a2, u2, a3] = consumedRead();
		const sole = [u1, a1, r1, a2, checkpointRecord("cp1", ["r1"]), u2, a3].map((entry, index, all) => ({
			...entry,
			parentId: index ? all[index - 1].id : null,
		})) as SessionEntry[];
		expect(reducedIds(reduceRecords(sole, undefined))).toEqual([]);
		const shared = structuredClone(sole);
		const checkpoint = shared[4];
		if (checkpoint.type === "compaction") {
			(checkpoint.details as { note: { state: { sources: string[] }[] } }).note.state[0].sources = ["r1", "u1"];
		}
		expect(reducedIds(reduceRecords(shared, undefined))).toEqual(["r1"]);
	});
	it("keeps an entry a saved work-note fact cites alone", () => {
		const [u1, a1, r1, a2, u2, a3] = consumedRead();
		const noted = [u1, a1, r1, a2, workNoteRecord("note1", ["r1"]), u2, a3].map((entry, index, all) => ({
			...entry,
			parentId: index ? all[index - 1].id : null,
		})) as SessionEntry[];
		expect(reducedIds(reduceRecords(noted, undefined))).toEqual([]);
	});
	it("never un-reduces an entry a later checkpoint fact cites alone", () => {
		const records = consumedRead();
		expect(reducedIds(reduceRecords(records, undefined))).toEqual(["r1"]);
		const later = [...records, { ...checkpointRecord("cp1", ["r1"]), parentId: "a3" }] as SessionEntry[];
		expect(reducedIds(reduceRecords(later, undefined))).toEqual(["r1"]);
	});
	it("keeps error results and the excluded tool set full", () => {
		const error = chain(
			user("u1", "Keep the service on port 4317."),
			call("a1", "call-1", "read", { path: "/srv/app.log" }),
			result("r1", "call-1", "read", BIG_RESULT, { isError: true }),
			reply("a2"),
			user("u2", "Summarize."),
			reply("a3"),
		);
		expect(reducedIds(reduceRecords(error, undefined))).toEqual([]);
		const note = chain(
			user("u1", "Keep the service on port 4317."),
			call("a1", "call-1", "context_note", { state: [] }),
			result("r1", "call-1", "context_note", BIG_RESULT),
			reply("a2"),
			user("u2", "Summarize."),
			reply("a3"),
		);
		expect(reducedIds(reduceRecords(note, undefined))).toEqual([]);
	});
	it("touches only tool results: user messages, assistant text and checkpoint summaries pass through", () => {
		const records = consumedRead();
		const view = reduceRecords(records, undefined);
		const messages: AgentMessage[] = [
			{ role: "compactionSummary", summary: BIG_RESULT, timestamp: 1 } as unknown as AgentMessage,
			...buildSessionProjection([...records]).messages,
		];
		const reduced = applyReduction(messages, view);
		for (const [index, message] of reduced.entries()) {
			if (message.role === "toolResult") continue;
			expect(message).toBe(messages[index]);
		}
		const toolResult = reduced.find((message) => message.role === "toolResult");
		expect(JSON.stringify(toolResult)).toContain("[reduced tool result]");
	});
	it("reduces a superseded read while the latest read of the same target stays full", () => {
		const records = chain(
			user("u1", "Keep the service on port 4317."),
			call("a1", "call-1", "read", { path: "/srv/app.log" }),
			result("r1", "call-1", "read", BIG_RESULT),
			reply("a2", "The log is read."),
			user("u2", "Read it again."),
			call("a3", "call-2", "read", { path: "/srv/app.log" }),
			result("r2", "call-2", "read", SMALL_RESULT),
		);
		expect(reducedIds(reduceRecords(records, undefined))).toEqual(["r1"]);
		const otherTarget = structuredClone(records);
		const second = otherTarget[5];
		if (second.type === "message" && second.message.role === "assistant") {
			const block = second.message.content[0];
			if (block.type === "toolCall") block.arguments = { path: "/srv/other.log" };
		}
		expect(reducedIds(reduceRecords(otherTarget, undefined))).toEqual([]);
	});
	it("suffix trigger: a result whose remaining suffix outweighs its saving stays full", () => {
		const records = chain(
			user("u1", "Keep the service on port 4317."),
			call("a1", "call-1", "read", { path: "/srv/app.log" }),
			result("r1", "call-1", "read", SMALL_RESULT),
			reply("a2", `A very long reply. ${"detail ".repeat(400)}`),
			user("u2", "Summarize."),
			reply("a3"),
		);
		expect(reducedIds(reduceRecords(records, undefined))).toEqual([]);
	});
	it("idle trigger: a recorded gap longer than the declared lifetime reduces, read from timestamps only", () => {
		const gapped = (gapMs: number) =>
			chain(
				user("u1", "Keep the service on port 4317."),
				call("a1", "call-1", "read", { path: "/srv/app.log" }),
				result("r1", "call-1", "read", SMALL_RESULT, { ts: "2026-01-01T00:00:00.000Z" }),
				reply(
					"a2",
					`A very long reply. ${"detail ".repeat(400)}`,
					new Date(Date.parse("2026-01-01T00:00:00.000Z") + gapMs).toISOString(),
				),
				user("u2", "Summarize."),
				reply("a3"),
			);
		// No declared lifetime: one hour is assumed.
		expect(reducedIds(reduceRecords(gapped(30 * 60_000), undefined))).toEqual([]);
		expect(reducedIds(reduceRecords(gapped(2 * DEFAULT_CACHE_LIFETIME_MS), undefined))).toEqual(["r1"]);
		// A declared five-minute lifetime makes the same thirty-minute gap idle.
		expect(reducedIds(reduceRecords(gapped(30 * 60_000), 300_000))).toEqual(["r1"]);
	});
	it("reads the declared cache lifetime from the model's longest tier", () => {
		expect(declaredCacheLifetimeMs(undefined)).toBeUndefined();
		expect(declaredCacheLifetimeMs({})).toBeUndefined();
		expect(declaredCacheLifetimeMs({ promptCache: { short: 300 } })).toBe(300_000);
		expect(declaredCacheLifetimeMs({ promptCache: { short: 300, long: 7200 } })).toBe(7_200_000);
	});
	it("replaces an eligible result with one line naming the tool, target, first result line and record ID", () => {
		const view = reduceRecords(consumedRead(), undefined);
		expect(view.entries).toHaveLength(1);
		const { line } = view.entries[0];
		expect(line).toBe(reductionLine("read", "/srv/app.log", RESULT_MARKER, "r1"));
		expect(line).not.toContain("\n");
		for (const part of ["read", "/srv/app.log", RESULT_MARKER, "entry r1", "context_history"]) {
			expect(line).toContain(part);
		}
		expect(line).toContain("back in full");
	});
	it("returns the reduced entry's original text in full through context_history", () => {
		const session = new SyntheticSession(fs.mkdtempSync(join(tmpdir(), "pi-reduction-history-")), consumedRead());
		const view = reduceRecords(session.getBranch(), undefined);
		expect(reducedIds(view)).toEqual(["r1"]);
		const page = queryHistory(freezeHistory(session), { operation: "read", entryId: "r1" });
		const text = page.entries.map((entry) => entry.text).join("");
		expect(text).toContain(RESULT_MARKER);
		expect(text).toContain("log line: local check ok");
		expect(text).not.toContain("[reduced tool result]");
	});
});

/** A public read-only session surface; no patched SessionManager is used in these tests. */
class SyntheticSession implements PreviewSession {
	readonly header: SessionHeader;
	entries: SessionEntry[];
	file: string | undefined;
	leafId: string | null;
	readonly root: string;
	constructor(root: string, entries: SessionEntry[], id = "synthetic-session") {
		this.root = root;
		this.entries = structuredClone(entries);
		this.leafId = this.entries[this.entries.length - 1]?.id ?? null;
		this.file = join(root, `${id}.jsonl`);
		this.header = { type: "session", version: 3, id, timestamp, cwd: root };
		this.persist();
	}
	persist(entries = this.entries): void {
		if (!this.file) throw new Error("Synthetic session has no persistence path");
		fs.writeFileSync(this.file, `${[this.header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
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
		const visited = new Set<string>();
		while (entry && !visited.has(entry.id)) {
			visited.add(entry.id);
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
	append(entry: SessionEntry, persist = true): void {
		this.entries.push(entry);
		this.leafId = entry.id;
		if (persist) this.persist();
	}
}

describe("reduction wiring", () => {
	let root: string;
	let session: SyntheticSession;
	let requests: Context[];
	let output: MemoryNote;
	const model: Model<Api> = {
		id: "preview-test",
		name: "Synthetic writer",
		provider: "preview-test",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const registry = {
		find: () => model,
		hasConfiguredAuth: () => true,
		streamSimple: (_model: Model<Api>, context: Context) => {
			requests.push(structuredClone(context));
			const message = {
				...assistantStop(JSON.stringify(output)),
				content: [{ type: "text" as const, text: JSON.stringify(output) }],
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	};
	function context(target: SyntheticSession = session): ExtensionContext {
		return {
			sessionManager: target,
			model,
			modelRegistry: registry,
			thinkingLevel: "off",
			getSystemPrompt: () => "Synthetic system prompt.",
			hasPendingMessages: () => false,
			getContextUsage: () => ({ tokens: 2000, contextWindow: 128_000, percent: null }),
			hasUI: false,
			ui: { notify: vi.fn() },
			abort: vi.fn(),
		} as unknown as ExtensionContext;
	}
	function controller(options?: {
		reduction?: { enabled: boolean; error?: "invalid-config" };
		writerModel?: string;
		storeRoot?: string;
	}) {
		return new PreviewMemoryController({
			config: {
				...DEFAULT_MEMORY_CONFIG,
				writerModel: options?.writerModel ?? "preview-test/preview-test",
				noteRepair: false,
			},
			failureStore: new PreviewFailureStore(join(options?.storeRoot ?? root, "agent")),
			...("reduction" in (options ?? {}) ? { reduction: options?.reduction } : { reduction: { enabled: true } }),
		});
	}
	function event(): SessionBeforeCompactEvent {
		return {
			type: "session_before_compact",
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
			preparation: { tokensBefore: 2000 },
		} as SessionBeforeCompactEvent;
	}
	beforeEach(() => {
		root = fs.mkdtempSync(join(tmpdir(), "pi-preview-reduction-"));
		session = new SyntheticSession(root, consumedRead());
		requests = [];
		output = {
			instructions: [],
			failedPaths: [],
			reasons: [],
			state: [{ text: "The service uses port 4317.", sources: ["u1"] }],
			nextSteps: [],
			files: [],
			gaps: [],
		};
	});
	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});
	const projectionText = (subject: PreviewMemoryController, ctx: ExtensionContext) =>
		JSON.stringify(subject.context(ctx.sessionManager.buildSessionProjection().messages, ctx));

	it("projects the reduced view deterministically across calls, a reopen and a simulated restart", () => {
		const ctx = context();
		const first = controller();
		const before = JSON.stringify(session.getBranch());
		const projected = projectionText(first, ctx);
		expect(projected).toContain("[reduced tool result]");
		expect(projected).not.toContain("log line: local check ok");
		expect(projectionText(first, ctx)).toBe(projected);
		// Original records are untouched on disk and in memory.
		expect(JSON.stringify(session.getBranch())).toBe(before);
		expect(fs.readFileSync(session.getSessionFile()!, "utf8")).toContain("log line: local check ok");
		// A simulated restart: a fresh controller and failure store over the same session.
		expect(projectionText(controller(), ctx)).toBe(projected);
		// A reopen: the same persisted entries read into a fresh session object.
		const reopened = new SyntheticSession(root, session.getBranch());
		expect(projectionText(controller(), context(reopened))).toBe(projected);
		expect((ctx.abort as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});
	it("reduces the writer's session prefix and the context projection identically", async () => {
		const subject = controller({ writerModel: DEFAULT_MEMORY_CONFIG.writerModel });
		const ctx = context();
		const projected = subject.context(session.buildSessionProjection().messages, ctx);
		const value = await subject.compact(event(), ctx);
		expect(value.details?.kind).toBe(CONTEXT_MEMORY_KIND);
		expect(requests).toHaveLength(1);
		// The writer request is the reduced session prefix plus one closing instruction.
		const prefix = requests[0].messages.slice(0, -1);
		expect(JSON.stringify(prefix)).toBe(JSON.stringify(convertToLlm([...projected])));
		expect(JSON.stringify(prefix)).toContain("[reduced tool result]");
		expect(JSON.stringify(prefix)).not.toContain("log line: local check ok");
		// The writer's cited evidence and the manifest keep reading originals.
		const instruction = requests[0].messages[requests[0].messages.length - 1];
		expect(JSON.stringify(instruction)).toContain("r1");
	});
	it("commits, validates and reopens a compaction over a reduced view, equal to one without reduction", async () => {
		// The session writer reads the reduced prefix; the committed checkpoint must not depend on it.
		const on = controller({ reduction: { enabled: true }, writerModel: DEFAULT_MEMORY_CONFIG.writerModel });
		const offRoot = fs.mkdtempSync(join(tmpdir(), "pi-reduction-off-"));
		const off = controller({
			reduction: { enabled: false },
			writerModel: DEFAULT_MEMORY_CONFIG.writerModel,
			storeRoot: offRoot,
		});
		const offSession = new SyntheticSession(offRoot, session.getBranch());
		const reducedValue = await on.compact(event(), context());
		const plainValue = await off.compact(event(), context(offSession));
		const comparable = (value: PreviewCompaction) =>
			JSON.stringify([value.summary, value.firstKeptEntryId, value.details]);
		expect(comparable(reducedValue)).toBe(comparable(plainValue));
		expect(JSON.stringify(reducedValue)).not.toContain("[reduced tool result]");
		const entry = {
			type: "compaction" as const,
			id: "checkpoint-1",
			parentId: session.getLeafId(),
			timestamp,
			...reducedValue,
			fromHook: true,
		};
		session.append(entry as SessionEntry);
		on.committed(
			{ type: "session_compact", compactionEntry: entry, fromExtension: true, reason: "manual", willRetry: false },
			context(),
		);
		const reopened = new SyntheticSession(root, session.getBranch());
		expect(() => assertPreviewSession(reopened)).not.toThrow();
		const ctx = context(reopened);
		const projected = controller().context(reopened.buildSessionProjection().messages, ctx);
		expect((ctx.abort as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
		expect(projected.some((message) => message.role === "compactionSummary")).toBe(true);
	});
	it("treats an off, invalid and absent switch identically: requests stay unreduced", () => {
		const input = () => session.buildSessionProjection().messages;
		const expected = JSON.stringify(input());
		for (const options of [
			{ reduction: { enabled: false } },
			{ reduction: { enabled: false, error: "invalid-config" as const } },
			{ reduction: undefined },
		]) {
			const ctx = context();
			expect(JSON.stringify(controller(options).context(input(), ctx))).toBe(expected);
			expect((ctx.abort as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
		}
	});
	it("parses previewReduction like the previewPreparation switch: off by default, disabled when invalid", () => {
		const cases: [string | undefined, { enabled: boolean; error?: string }][] = [
			[undefined, { enabled: false }],
			[JSON.stringify({}), { enabled: false }],
			[JSON.stringify({ previewReduction: {} }), { enabled: false }],
			[JSON.stringify({ previewReduction: { enabled: true } }), { enabled: true }],
			[JSON.stringify({ previewReduction: { enabled: "yes" } }), { enabled: false, error: "invalid-config" }],
			["{ not json", { enabled: false, error: "invalid-config" }],
		];
		for (const [content, expected] of cases) {
			const agentDir = fs.mkdtempSync(join(tmpdir(), "pi-reduction-settings-"));
			if (content !== undefined) fs.writeFileSync(join(agentDir, "pi-context-memory.json"), content);
			expect(readPreparationSettings(agentDir).reduction).toEqual(expected);
		}
	});
	it("reports content-free counts: entries reduced, estimated tokens removed and read-backs", () => {
		const subject = controller();
		const ctx = context();
		const status = subject.status(ctx) as { reduction?: Record<string, unknown> };
		expect(status.reduction).toBeDefined();
		expect(Object.keys(status.reduction!).sort()).toEqual([
			"enabled",
			"entriesReduced",
			"estimatedTokensRemoved",
			"readBacks",
		]);
		expect(status.reduction).toMatchObject({ enabled: true, entriesReduced: 1, readBacks: 0 });
		expect(status.reduction!.estimatedTokensRemoved).toBeGreaterThan(0);
		const serialized = JSON.stringify(status.reduction);
		expect(serialized).not.toContain("r1");
		expect(serialized).not.toContain("app.log");
		subject.recordHistoryRead(ctx, "r1");
		subject.recordHistoryRead(ctx, "u1");
		expect((subject.status(ctx) as { reduction?: { readBacks: number } }).reduction?.readBacks).toBe(1);
		const invalid = controller({ reduction: { enabled: false, error: "invalid-config" } });
		expect((invalid.status(ctx) as { reduction?: unknown }).reduction).toEqual({
			enabled: false,
			reason: "invalid-config",
		});
		const absent = controller({ reduction: undefined });
		expect((absent.status(ctx) as { reduction?: unknown }).reduction).toBeUndefined();
	});
});
