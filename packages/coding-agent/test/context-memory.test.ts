import { fork } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { DEFAULT_MEMORY_CONFIG, memoryBudget, readMemoryConfig } from "../src/extensions/context-memory/config.ts";
import { chooseCut, MemoryController } from "../src/extensions/context-memory/controller.ts";
import {
	EVENT_CAPS,
	EVENT_LOG_FILE,
	EVENT_LOG_ROTATE_BYTES,
	EventLog,
	errorCode,
	type MemoryEvent,
} from "../src/extensions/context-memory/events.ts";
import { saveHistoryGrant } from "../src/extensions/context-memory/grant-file.ts";
import {
	freezeHistory,
	grantedHistory,
	issueHistoryGrant,
	queryHistory,
	revokeHistoryGrant,
} from "../src/extensions/context-memory/history.ts";
import { CONTEXT_KEEP_NONE, CONTEXT_MEMORY_KIND, hashEntries } from "../src/extensions/context-memory/identity.ts";
import { SessionLease } from "../src/extensions/context-memory/lease.ts";
import { latestMemory, type MemoryNote, validateNote } from "../src/extensions/context-memory/notes.ts";

vi.mock("node:fs", async (original) => {
	const actual = await original<typeof fs>();
	return {
		...actual,
		writeFileSync: vi.fn(actual.writeFileSync),
		fsyncSync: vi.fn(actual.fsyncSync),
		linkSync: vi.fn(actual.linkSync),
	};
});
const actualFs = await vi.importActual<typeof fs>("node:fs");
const usage = {
	input: 12,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model: Model<Api> = {
	id: "memory-test",
	name: "Memory test",
	provider: "memory-test",
	api: "openai-completions",
	baseUrl: "https://memory.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function reply(text = "acknowledged"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: Date.now(),
		usage,
	};
}
function note(id: string, text = "Use port 4317; port 9000 was rejected after the collision."): MemoryNote {
	return {
		instructions: [],
		failedPaths: [],
		reasons: [],
		state: [{ text, sources: [id] }],
		nextSteps: [],
		files: [],
		gaps: [],
	};
}

describe("context memory: persistence, authorization and stop-send contracts", () => {
	let root: string;
	const managers: SessionManager[] = [];
	const sessions: AgentSession[] = [];
	beforeEach(() => {
		vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actualFs.writeFileSync);
		vi.mocked(fs.fsyncSync).mockReset().mockImplementation(actualFs.fsyncSync);
		vi.mocked(fs.linkSync).mockReset().mockImplementation(actualFs.linkSync);
		root = fs.mkdtempSync(join(tmpdir(), "pi-context-memory-"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) session.dispose();
		for (const manager of managers.splice(0)) manager.close();
		fs.rmSync(root, { recursive: true, force: true });
	});
	function manager(persist = true): SessionManager {
		const session = persist ? SessionManager.create(root, root) : SessionManager.inMemory(root);
		managers.push(session);
		return session;
	}
	function seed(session: SessionManager) {
		const id = session.appendMessage({
			role: "user",
			content: "Use port 4317; port 9000 was rejected after the collision.",
			timestamp: 1,
		});
		session.appendMessage(reply());
		session.appendMessage({ role: "user", content: "Continue with that decision.", timestamp: 3 });
		session.appendMessage(reply("Ready."));
		return id;
	}
	async function sdk(
		sessionManager: SessionManager,
		options: {
			enabled?: boolean;
			eventLog?: boolean;
			extensions?: ExtensionFactory[];
			filter?: boolean;
			selectedModel?: Model<Api>;
			writerModel?: string;
			keepRecentTokens?: number;
		} = {},
	) {
		const agentDir = fs.mkdtempSync(join(root, "agent-"));
		fs.writeFileSync(
			join(agentDir, "pi-context-memory.json"),
			JSON.stringify({
				enabled: options.enabled ?? true,
				...(options.eventLog === undefined ? {} : { eventLog: options.eventLog }),
				writerModel: options.writerModel ?? "memory-test/memory-writer",
				writerEffort: "medium",
				...(options.keepRecentTokens === undefined ? {} : { keepRecentTokens: options.keepRecentTokens }),
			}),
		);
		const selectedModel = options.selectedModel ?? model;
		const credentials = AuthStorage.inMemory();
		await credentials.modify(model.provider, async () => ({ type: "api_key", key: "fake-test-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		let requests = 0;
		runtime.registerProvider(model.provider, {
			api: model.api,
			apiKey: "fake-test-key",
			models: [selectedModel, { ...model, id: "memory-writer" }],
			streamSimple: () => {
				requests++;
				const stream = createAssistantMessageEventStream();
				const message = reply();
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			},
		});
		const settings = SettingsManager.inMemory({ retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "Continue the task using authorized evidence.",
			extensionFactories: options.extensions,
			extensionsOverride: options.filter ? (result) => ({ ...result, extensions: [] }) : undefined,
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			modelRuntime: runtime,
			model: selectedModel,
			sessionManager,
			settingsManager: settings,
			resourceLoader: loader,
		});
		sessions.push(session);
		await session.bindExtensions({});
		return { session, runtime, settings, agentDir, requests: () => requests };
	}
	function events(agentDir: string): MemoryEvent[] {
		const file = join(agentDir, EVENT_LOG_FILE);
		if (!fs.existsSync(file)) return [];
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as MemoryEvent);
	}
	function rawEvents(agentDir: string): string {
		return fs.readFileSync(join(agentDir, EVENT_LOG_FILE), "utf8");
	}

	it("first flush includes the candidate; a failed append restores file length and never advances the tree", () => {
		const store = manager();
		const user = store.appendMessage({ role: "user", content: "retain this", timestamp: 1 });
		expect(fs.existsSync(store.getSessionFile()!)).toBe(false);
		store.appendMessage(reply());
		expect(loadEntriesFromFile(store.getSessionFile()!).length).toBe(3);
		const before = fs.readFileSync(store.getSessionFile()!, "utf8");
		const leaf = store.getLeafId();
		vi.mocked(fs.writeFileSync).mockImplementationOnce((...args) => {
			actualFs.writeFileSync(...args);
			throw new Error("injected partial write");
		});
		expect(() => store.appendCustomEntry("candidate", { attempt: 1 })).toThrow("injected partial write");
		expect(fs.readFileSync(store.getSessionFile()!, "utf8")).toBe(before);
		expect(store.getLeafId()).toBe(leaf);
		expect(store.getEntries().map((entry) => entry.id)).toContain(user);
	});

	it("metadata-only updates allow continued writes while external content changes are rejected", () => {
		const store = manager();
		seed(store);
		const file = store.getSessionFile()!;
		fs.chmodSync(file, 0o640);
		expect(() => store.appendCustomEntry("after-metadata", {})).not.toThrow();
		fs.appendFileSync(file, "external writer\n");
		const leaf = store.getLeafId();
		expect(() => store.appendCustomEntry("after-external-write", {})).toThrow("CONTEXT_EXTERNAL_WRITE");
		expect(store.getLeafId()).toBe(leaf);
	});

	it("a checkpoint forces first flush and a failed first publication can be retried without duplicate headers", () => {
		const store = manager();
		const id = store.appendMessage({ role: "user", content: "initial evidence", timestamp: 1 });
		vi.mocked(fs.linkSync).mockImplementationOnce(() => {
			throw new Error("injected publication failure");
		});
		expect(() => store.appendCompaction("checkpoint", id, 20)).toThrow("publication failure");
		expect(store.getLeafId()).toBe(id);
		expect(fs.existsSync(store.getSessionFile()!)).toBe(false);
		store.appendCompaction("checkpoint", id, 20);
		const entries = loadEntriesFromFile(store.getSessionFile()!);
		expect(entries.filter((entry) => entry.type === "session")).toHaveLength(1);
		expect(entries[entries.length - 1].type).toBe("compaction");
	});

	it("failed rollback poisons later writes", () => {
		const store = manager();
		seed(store);
		vi.mocked(fs.fsyncSync)
			.mockImplementationOnce(() => {
				throw new Error("disk failure");
			})
			.mockImplementationOnce(() => {
				throw new Error("rollback failure");
			});
		expect(() => store.appendCustomEntry("candidate", {})).toThrow("disk failure");
		expect(() => store.appendCustomEntry("later", {})).toThrow("CONTEXT_STORAGE_UNCERTAIN");
		const file = store.getSessionFile()!;
		store.close();
		expect(() => SessionManager.open(file)).toThrow("CONTEXT_STORAGE_UNCERTAIN");
	});

	it("another same-process writer is rejected; a failed fork leaves the source identity and bytes intact", () => {
		const source = manager();
		const id = seed(source);
		const file = source.getSessionFile()!;
		const before = fs.readFileSync(file, "utf8");
		expect(() => SessionManager.open(file)).toThrow("CONTEXT_LOCKED");
		vi.mocked(fs.linkSync).mockImplementationOnce(() => {
			throw new Error("fork write failed");
		});
		expect(() => source.createBranchedSession(id)).not.toThrow(); // No assistant: a deferred fork needs no first flush.
		// The original source is still readable and unchanged; use a real persisted branch for the failure case.
		source.setSessionFile(file);
		expect(() => source.createBranchedSession(source.getLeafId()!)).toThrow("fork write failed");
		expect(source.getSessionFile()).toBe(file);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
		const forked = source.forkBranch(source.getLeafId()!);
		managers.push(forked);
		expect(forked.getSessionFile()).not.toBe(file);
		expect(forked.getBranch().length).toBe(source.getBranch().length);
	});

	it("opaque branches are blocked before writable resume even while the feature is disabled", async () => {
		const source = manager();
		const id = seed(source);
		source.appendCompaction("Opaque checkpoint", id, 10, { kind: "pi-codex-remote-compaction" });
		const file = source.getSessionFile()!;
		const bytes = fs.readFileSync(file, "utf8");
		source.close();
		expect(() => SessionManager.open(file)).toThrow("CONTEXT_MIGRATION_REQUIRED");
		expect(fs.readFileSync(file, "utf8")).toBe(bytes);
		const memory = manager(false);
		seed(memory);
		const { session } = await sdk(memory, { enabled: false });
		memory.appendCompaction("Opaque checkpoint", memory.getBranch()[0].id, 10, {
			kind: "pi-codex-remote-compaction",
		});
		await expect(session.extensionRunner.emitContext(session.messages)).rejects.toThrow("CONTEXT_MIGRATION_REQUIRED");
	});

	it("read cursors survive appended tool messages but cannot cross to a sibling branch", () => {
		const store = manager(false);
		const first = store.appendMessage({ role: "user", content: "source-".repeat(6000), timestamp: 1 });
		const initial = freezeHistory(store);
		const page = queryHistory(initial, { operation: "read", entryId: first }, 800);
		expect(page.cursor).toBeTruthy();
		const child = store.appendMessage(reply("a tool interaction appended while reading"));
		const next = queryHistory(freezeHistory(store), { operation: "read", entryId: first, cursor: page.cursor }, 800);
		expect(next.entries[0].offset).toBe(page.entries[0].text.length);
		store.resetLeaf();
		store.appendMessage({ role: "user", content: "sibling secret", timestamp: 3 });
		expect(() =>
			queryHistory(freezeHistory(store), { operation: "read", entryId: first, cursor: next.cursor }, 800),
		).toThrow("HISTORY_CURSOR_INVALID");
		store.branch(child);
		expect(queryHistory(freezeHistory(store), { operation: "search", query: "sibling secret" }).entries).toHaveLength(
			0,
		);
	});

	it("grants exclude future entries, siblings, different children and revoked sources", () => {
		const parent = manager(false);
		const allowed = seed(parent);
		const grant = issueHistoryGrant(parent, "child-a", [allowed]);
		const future = parent.appendMessage({ role: "user", content: "future secret", timestamp: 5 });
		expect(() => grantedHistory(grant.grantId, "child-b")).toThrow("HISTORY_SCOPE_DENIED");
		expect(() =>
			queryHistory(grantedHistory(grant.grantId, "child-a"), { operation: "read", entryId: future }),
		).toThrow("HISTORY_SCOPE_DENIED");
		expect(
			queryHistory(grantedHistory(grant.grantId, "child-a"), { operation: "read", entryId: allowed }).entries[0]
				.text,
		).toContain("4317");
		const original = parent.getEntry(allowed)!;
		if (original.type === "message" && original.message.role === "user")
			original.message.content = "modified after grant";
		expect(() => grantedHistory(grant.grantId, "child-a")).toThrow("HISTORY_SCOPE_DENIED");
		revokeHistoryGrant(grant.grantId);
		expect(() => grantedHistory(grant.grantId, "child-a")).toThrow("HISTORY_SCOPE_DENIED");
	});

	it("notes reject forged citations and inaccurate quotations", () => {
		const store = manager(false);
		const id = seed(store);
		expect(() => validateNote(note("not-an-entry"), store.getBranch())).toThrow("CONTEXT_NOTE_SCOPE");
		const candidate = note(id);
		candidate.state[0].quote = "Use port 9000";
		expect(() => validateNote(candidate, store.getBranch())).toThrow("CONTEXT_NOTE_QUOTE");
	});

	it("the resident survives ordinary filtering and reload, and the enable flag stays latched until restart", async () => {
		const { session, agentDir } = await sdk(manager(false), {
			filter: true,
			extensions: [(pi) => pi.on("session_start", () => {})],
		});
		expect(session.extensionRunner.getExtensionPaths()).toEqual(["<builtin:context-memory>"]);
		expect(session.getActiveToolNames()).toContain("context_history");
		fs.writeFileSync(join(agentDir, "pi-context-memory.json"), '{"enabled":false}');
		await session.reload();
		expect(session.extensionRunner.getExtensionPaths()).toEqual(["<builtin:context-memory>"]);
		expect(session.hasExtensionHandlers("session_before_compact")).toBe(true);
	});

	it("a session_before_compact observer runs before the writer and does not block compaction", async () => {
		const store = manager();
		const original = seed(store);
		const order: string[] = [];
		const observer = vi.fn(() => {
			order.push("observer");
			return undefined;
		});
		const { session, runtime } = await sdk(store, {
			extensions: [(pi) => pi.on("session_before_compact", observer)],
		});
		vi.spyOn(runtime, "completeSimple").mockImplementation(async () => {
			order.push("writer");
			return reply(JSON.stringify(note(original)));
		});
		await session.compact();
		expect(observer).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["observer", "writer"]);
		expect(latestMemory(store.getBranch())?.memory.note.state[0].text).toContain("4317");
	});

	it("a second compactor's result is rejected before the writer runs", async () => {
		for (const competing of [
			{ compaction: { summary: "foreign", firstKeptEntryId: "x", tokensBefore: 1 } },
			{ cancel: true },
		]) {
			const store = manager();
			seed(store);
			const { session, runtime } = await sdk(store, {
				extensions: [(pi) => pi.on("session_before_compact", () => competing as never)],
			});
			const writer = vi.spyOn(runtime, "completeSimple");
			await expect(session.compact()).rejects.toThrow("CONTEXT_COMPACTOR_CONFLICT");
			expect(writer).not.toHaveBeenCalled();
			expect(latestMemory(store.getBranch())).toBeUndefined();
		}
	});

	it("two checkpoints retain raw-source coverage and latest decisions across reopen", async () => {
		const store = manager();
		const original = seed(store);
		const { session, runtime } = await sdk(store);
		const calls = vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(original))));
		await session.compact();
		const first = latestMemory(store.getBranch());
		expect(first?.memory.note.state[0].text).toContain("4317");
		const revised = store.appendMessage({
			role: "user",
			content: "Latest decision: use port 4318 after a second collision.",
			timestamp: 6,
		});
		store.appendMessage(reply());
		calls.mockResolvedValue(
			reply(JSON.stringify(note(revised, "Latest decision: use port 4318 after a second collision."))),
		);
		await session.compact();
		expect(calls).toHaveBeenCalledTimes(2);
		expect(latestMemory(store.getBranch())?.memory.note.state[0].text).toContain("4318");
		const file = store.getSessionFile()!;
		session.dispose();
		const reopened = SessionManager.open(file);
		managers.push(reopened);
		expect(latestMemory(reopened.getBranch())?.memory.note.state[0].text).toContain("4318");
		expect(queryHistory(freezeHistory(reopened), { operation: "read", entryId: original }).entries[0].text).toContain(
			"9000",
		);
	});

	it("a failed automatic compact blocks the following provider request and does not retry the writer", async () => {
		const store = manager(false);
		for (let round = 0; round < 6; round++) {
			store.appendMessage({ role: "user", content: "evidence ".repeat(2000), timestamp: round + 1 });
			store.appendMessage({
				...reply(),
				usage: { ...usage, input: (round + 1) * 5000, totalTokens: (round + 1) * 5000 + 8 },
			});
		}
		const { session, runtime, requests, agentDir } = await sdk(store, {
			selectedModel: { ...model, contextWindow: 30_000 },
		});
		const writer = vi
			.spyOn(runtime, "completeSimple")
			.mockRejectedValue(new Error("injected writer failure at /private/path/secret.txt"));
		await session.prompt("Continue.");
		expect(requests()).toBe(0);
		expect(writer).toHaveBeenCalledTimes(1);
		expect(store.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		// Exactly one failed attempt is logged, by class only; the blocked request is counted once.
		const logged = events(agentDir);
		const compactions = logged.filter((event) => event.event === "compaction");
		expect(compactions).toHaveLength(1);
		expect(compactions[0]).toMatchObject({ outcome: "failed", reason: "threshold", errorCode: "UNKNOWN" });
		expect(logged.filter((event) => event.event === "guard").map((event) => event.code)).toEqual(["CONTEXT_BLOCKED"]);
		expect(rawEvents(agentDir)).not.toContain("secret");
		expect(rawEvents(agentDir)).not.toContain("evidence");
	});

	it("committed compactions and history reads are logged as counts, sizes and durations without content", async () => {
		const store = manager();
		const original = seed(store);
		const { session, runtime, agentDir } = await sdk(store);
		vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(original))));
		await session.compact();
		const history = session.agent.state.tools.find((tool) => tool.name === "context_history");
		if (!history) throw new Error("context_history not active");
		await history.execute("call-1", { operation: "search", query: "collision" });
		await expect(history.execute("call-2", { operation: "read", entryId: "missing-entry" })).rejects.toThrow();
		const logged = events(agentDir);
		const compaction = logged.find((event) => event.event === "compaction");
		if (compaction?.event !== "compaction") throw new Error("compaction event missing");
		expect(compaction).toMatchObject({
			outcome: "committed",
			reason: "manual",
			willRetry: false,
			model: model.id,
			writerModel: "memory-test/memory-writer",
			chunkCount: 1,
			usage: { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, cost: 0 },
			checkpointId: latestMemory(store.getBranch())?.entry.id,
		});
		expect(compaction.errorCode).toBeUndefined();
		expect(compaction.compactMs).toBeGreaterThanOrEqual(compaction.writerMs ?? 0);
		expect(compaction.tokensBefore).toBeGreaterThan(0);
		expect(compaction.noteTokens).toBeGreaterThan(0);
		expect(compaction.tokensAfter).toBeLessThanOrEqual(compaction.threshold ?? 0);
		expect(compaction.sourceEntries).toBe(4);
		expect(compaction.increments).toBe(0);
		expect(logged.filter((event) => event.event === "history")).toEqual([
			expect.objectContaining({ operation: "search", granted: false, entries: 1, cursor: false }),
			expect.objectContaining({ operation: "read", granted: false, errorCode: "HISTORY_SCOPE_DENIED" }),
		]);
		const raw = rawEvents(agentDir);
		for (const secret of ["4317", "9000", "collision", "missing-entry", original]) expect(raw).not.toContain(secret);
		expect(fs.statSync(join(agentDir, EVENT_LOG_FILE)).mode & 0o077).toBe(0);
	});

	it("each session has an event quota per kind that survives restart, and the log rotates once", () => {
		const agentDir = fs.mkdtempSync(join(root, "agent-"));
		const file = join(agentDir, EVENT_LOG_FILE);
		const first = new EventLog(agentDir, true, "test-build");
		for (let i = 0; i < EVENT_CAPS.guard + 10; i++)
			first.record({ event: "guard", session: "s1", code: "CONTEXT_BLOCKED" });
		first.record({ event: "note", session: "s1", accepted: true });
		first.record({ event: "guard", session: "s2", code: "CONTEXT_BLOCKED" });
		const lines = () =>
			fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		const s1Guards = lines().filter((event) => event.session === "s1" && event.event === "guard");
		expect(s1Guards).toHaveLength(EVENT_CAPS.guard);
		expect(lines().filter((event) => event.event === "capped")).toEqual([
			expect.objectContaining({ session: "s1", kind: "guard", limit: EVENT_CAPS.guard }),
		]);
		expect(lines().filter((event) => event.session === "s2")).toHaveLength(1);
		// A new process reloads the quota from the file instead of starting from zero.
		const second = new EventLog(agentDir, true, "test-build");
		second.record({ event: "guard", session: "s1", code: "CONTEXT_BLOCKED" });
		second.record({ event: "note", session: "s1", accepted: true });
		expect(lines().filter((event) => event.session === "s1" && event.event === "guard")).toHaveLength(
			EVENT_CAPS.guard,
		);
		expect(lines().filter((event) => event.session === "s1" && event.event === "note")).toHaveLength(2);
		expect(second.lastError).toBeUndefined();
		fs.writeFileSync(file, "x".repeat(EVENT_LOG_ROTATE_BYTES));
		second.record({ event: "note", session: "s3", accepted: true });
		expect(fs.statSync(`${file}.1`).size).toBe(EVENT_LOG_ROTATE_BYTES);
		expect(lines()).toHaveLength(1);
	});

	it("the event log can be disabled and errors are reduced to bounded codes", async () => {
		const store = manager(false);
		seed(store);
		const { session, agentDir } = await sdk(store, { eventLog: false });
		await session.extensionRunner.emitContext(session.messages);
		expect(fs.existsSync(join(agentDir, EVENT_LOG_FILE))).toBe(false);
		expect(errorCode("Compaction failed: CONTEXT_SOURCE_CHANGED: discard the candidate")).toBe(
			"CONTEXT_SOURCE_CHANGED",
		);
		expect(errorCode("HISTORY_SCOPE_DENIED")).toBe("HISTORY_SCOPE_DENIED");
		expect(errorCode("This operation was aborted")).toBe("ABORTED");
		expect(errorCode(undefined, true)).toBe("ABORTED");
		expect(errorCode("request failed with status 429: rate limited")).toBe("HTTP_429");
		expect(errorCode("connect ECONNRESET 10.0.0.1:443")).toBe("ECONNRESET");
		expect(errorCode("Something at /Users/name/secret.txt went wrong")).toBe("UNKNOWN");
		// Uppercase tokens echoed from untrusted text are not classes.
		expect(errorCode("user said: HISTORY_OF_MY_MEDICAL_CONDITION")).toBe("UNKNOWN");
		expect(errorCode("CONTEXT_SOMETHING_NEW: not a known class")).toBe("UNKNOWN");
		expect(errorCode("EVERYTHING_BROKE")).toBe("UNKNOWN");
	});

	it("host refusals that never reached the resident are not counted as compaction failures", () => {
		const store = manager(false);
		seed(store);
		const agentDir = fs.mkdtempSync(join(root, "agent-"));
		const controller = new MemoryController({
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "memory-test/memory-writer" },
			events: new EventLog(agentDir, true, "test-build"),
			runtime: {} as never,
			session: store,
			setCompaction() {},
		});
		const failed = (errorMessage: string) =>
			controller.compactionFailed({
				type: "session_compact_failed",
				reason: "manual",
				errorMessage,
				aborted: false,
				willRetry: false,
				fromExtension: false,
			});
		failed("Compaction failed: Nothing to compact (session too small)");
		failed("Compaction failed: Already compacted");
		failed("Compaction failed: CONTEXT_BLOCKED: earlier failure");
		expect(events(agentDir)).toEqual([]);
		failed("Compaction failed: CONTEXT_COMPACTOR_CONFLICT: another extension returned a compaction");
		expect(events(agentDir).map((event) => (event.event === "compaction" ? event.errorCode : event.event))).toEqual([
			"CONTEXT_COMPACTOR_CONFLICT",
		]);
	});

	it("cancelled or stale candidates never publish", async () => {
		const store = manager(false);
		const id = seed(store);
		const { session, runtime, agentDir } = await sdk(store);
		let finish!: (response: AssistantMessage) => void;
		const writer = vi.spyOn(runtime, "completeSimple").mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const operation = session.compact();
		await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(1));
		session.abortCompaction();
		finish(reply(JSON.stringify(note(id))));
		await expect(operation).rejects.toThrow();
		expect(store.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		const next = session.compact();
		await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(2));
		store.appendCustomEntry("source-changed", {});
		finish(reply(JSON.stringify(note(id))));
		await expect(next).rejects.toThrow("CONTEXT_SOURCE_CHANGED");
		expect(store.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(
			events(agentDir)
				.filter((event) => event.event === "compaction")
				.map((event) => (event.event === "compaction" ? [event.outcome, event.errorCode] : [])),
		).toEqual([
			["aborted", "ABORTED"],
			["failed", "CONTEXT_SOURCE_CHANGED"],
		]);
	});

	it("storage rechecks the entire candidate source even when the leaf ID was not changed", () => {
		const store = manager(false);
		const id = seed(store);
		const branch = store.getBranch();
		const details = {
			kind: CONTEXT_MEMORY_KIND,
			sourceHash: hashEntries(branch),
			snapshot: { sessionId: store.getSessionId(), leafId: store.getLeafId(), lastCheckpointId: null },
		};
		const entry = store.getEntry(id)!;
		if (entry.type === "message" && entry.message.role === "user") entry.message.content = "mutated";
		expect(() => store.appendCompaction("stale", id, 10, details)).toThrow("CONTEXT_SOURCE_CHANGED");
	});

	it("an actual second process is excluded, then its crashed lease is recovered without a timeout", async () => {
		const file = join(root, "process.jsonl");
		const worker = fork(fileURLToPath(new URL("./fixtures/context-memory-lock-worker.ts", import.meta.url)), [file], {
			execArgv: [],
			silent: true,
		});
		try {
			await new Promise<void>((resolve, reject) => {
				worker.once("message", () => resolve());
				worker.once("error", reject);
				worker.once("exit", (code) => {
					if (code) reject(new Error(`Worker exited: ${code}`));
				});
			});
			expect(() => SessionLease.acquire(file)).toThrow("CONTEXT_LOCKED");
			const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
			worker.kill("SIGKILL");
			await exited;
			const recovered = SessionLease.acquire(file);
			recovered.assert();
			recovered.release();
			expect(fs.existsSync(`${file}.context.lock`)).toBe(false);
		} finally {
			worker.kill("SIGKILL");
		}
	});

	it("a real child process reads only its manifest scope and loses access on revocation", async () => {
		const parent = manager();
		const allowed = seed(parent);
		const grant = issueHistoryGrant(parent, "manifest-child", [allowed]);
		const manifest = saveHistoryGrant(grant.grantId, join(root, "grants"));
		expect(fs.statSync(manifest).mode & 0o077).toBe(0);
		const worker = fork(
			fileURLToPath(new URL("./fixtures/context-memory-grant-worker.ts", import.meta.url)),
			[manifest, "manifest-child", allowed],
			{ execArgv: [], silent: true },
		);
		const message = () =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				worker.once("message", (value) => resolve(value as Record<string, unknown>));
				worker.once("error", reject);
				worker.once("exit", (code) => {
					if (code) reject(new Error(`Grant worker exited: ${code}`));
				});
			});
		try {
			await message();
			const initial = message();
			worker.send("read");
			expect((await initial).text).toContain("4317");
			revokeHistoryGrant(grant.grantId);
			const revoked = message();
			worker.send("read");
			expect((await revoked).error).toContain("HISTORY_SCOPE_DENIED");
		} finally {
			const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
			worker.kill("SIGKILL");
			await exited;
		}
	});

	it("long source chunks advance without skipping text and include every writer call in usage", async () => {
		const store = manager(false);
		const content = "Each source segment remains retrievable. ".repeat(5000);
		const id = store.appendMessage({ role: "user", content, timestamp: 1 });
		store.appendMessage(reply());
		const { session, runtime } = await sdk(store);
		const writer = vi
			.spyOn(runtime, "completeSimple")
			.mockResolvedValue(reply(JSON.stringify(note(id, "Original source remains retrievable."))));
		const result = await session.compact();
		expect(writer.mock.calls.length).toBeGreaterThan(1);
		const originalParts = writer.mock.calls.flatMap((call) => {
			const message = call[1].messages[0];
			if (message.role !== "user" || typeof message.content !== "string")
				throw new Error("Unexpected writer request");
			const request = JSON.parse(message.content) as { newSources: { entryId: string; text: string }[] };
			return request.newSources.filter((part) => part.entryId === id).map((part) => part.text);
		});
		expect(originalParts.join("")).toBe(content);
		expect(result.usage?.input).toBe(writer.mock.calls.length * usage.input);
	});

	it("the session writer reuses the current provider prefix and leaves only the note in context", async () => {
		const store = manager();
		const original = seed(store);
		const { session, runtime, agentDir } = await sdk(store, { writerModel: "session" });
		const writer = vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(original))));
		const before = store.buildSessionContext().messages;
		expect(before.length).toBe(4);
		await session.compact();
		expect(writer).toHaveBeenCalledTimes(1);
		const [writerModel, context, options] = writer.mock.calls[0];
		expect(writerModel.id).toBe(model.id);
		expect(context.systemPrompt).toContain("Continue the task using authorized evidence.");
		// The four original messages come first, unchanged; the handover request is one closing user message.
		expect(context.messages.slice(0, 4).map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(context.messages).toHaveLength(5);
		const closing = context.messages[4];
		if (closing.role !== "user" || typeof closing.content !== "string") throw new Error("Unexpected closing message");
		expect(closing.content).toContain(original);
		expect(closing.content).not.toContain("port 9000 was rejected after the collision.".repeat(2));
		expect(context.tools?.map((tool) => tool.name)).toContain("context_history");
		expect(options?.reasoning).toBeUndefined();
		expect(options?.toolChoice).toBe("none");
		// Nothing but the note survives in model context; the originals stay on disk and on screen.
		const checkpoint = latestMemory(store.getBranch());
		expect(checkpoint?.entry.firstKeptEntryId).toBe(CONTEXT_KEEP_NONE);
		expect(checkpoint?.memory.writerModel).toBe(`${model.provider}/${model.id}`);
		expect(store.buildSessionContext().messages.map((message) => message.role)).toEqual(["compactionSummary"]);
		expect(queryHistory(freezeHistory(store), { operation: "read", entryId: original }).entries[0].text).toContain(
			"9000",
		);
		// A second checkpoint after new work accepts the keep-none sentinel and the session reopens cleanly.
		const revised = store.appendMessage({ role: "user", content: "Switch to port 4318.", timestamp: 7 });
		store.appendMessage(reply());
		writer.mockResolvedValue(reply(JSON.stringify(note(revised, "Switch to port 4318."))));
		await session.compact();
		expect(latestMemory(store.getBranch())?.memory.note.state[0].text).toBe("Switch to port 4318.");
		const file = store.getSessionFile()!;
		session.dispose();
		const reopened = SessionManager.open(file);
		managers.push(reopened);
		expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual(["compactionSummary"]);
		const logged = events(agentDir).filter((event) => event.event === "compaction");
		expect(logged).toHaveLength(2);
		expect(logged[0]).toMatchObject({
			outcome: "committed",
			writerModel: `${model.provider}/${model.id}`,
			keptMessages: 0,
			chunkCount: 1,
		});
	});

	it("reasoning effort reaches the writer only when the model declares reasoning support", async () => {
		const store = manager(false);
		const original = seed(store);
		const thinking: Model<Api> = { ...model, id: "memory-thinking", reasoning: true };
		const { session, runtime } = await sdk(store, { writerModel: "session", selectedModel: thinking });
		const writer = vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(original))));
		await session.compact();
		expect(writer.mock.calls[0][2]?.reasoning).toBe("medium");
	});

	it("an unreachable fixed writer is visible in status before any compaction is attempted", async () => {
		const store = manager(false);
		seed(store);
		const { session, runtime, agentDir } = await sdk(store, { writerModel: "memory-test/absent-writer" });
		const writer = vi.spyOn(runtime, "completeSimple");
		const controller = new MemoryController({
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "memory-test/absent-writer" },
			events: new EventLog(agentDir, false, "test-build"),
			runtime,
			session: store,
			setCompaction() {},
		});
		expect(controller.writerStatus(model)).toEqual({ error: "CONTEXT_WRITER_UNAVAILABLE" });
		expect(controller.status()).toMatchObject({
			writerModel: "memory-test/absent-writer",
			error: "CONTEXT_WRITER_UNAVAILABLE",
		});
		await expect(session.compact()).rejects.toThrow("CONTEXT_WRITER_UNAVAILABLE");
		expect(writer).not.toHaveBeenCalled();
	});

	it("the cut keeps nothing after a finished turn, keeps the open turn otherwise, and honors a positive budget", () => {
		const store = manager(false);
		const first = store.appendMessage({ role: "user", content: "Start.", timestamp: 1 });
		store.appendMessage(reply("Working."));
		const second = store.appendMessage({ role: "user", content: "Go on.", timestamp: 3 });
		store.appendMessage(reply("Done."));
		const branch = store.getBranch();
		const at = (id: string) => branch.findIndex((entry) => entry.id === id);
		expect(chooseCut(branch, 0, false)).toBe(branch.length);
		expect(chooseCut(branch, 0, true)).toBe(at(second));
		expect(chooseCut(branch, 1, false)).toBe(at(second));
		expect(chooseCut(branch, 10_000, false)).toBe(at(second));
		store.appendMessage({ role: "user", content: "One more.", timestamp: 5 });
		const open = store.appendMessage({
			...reply("Calling a tool."),
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } }],
			stopReason: "toolUse",
		});
		const unfinished = store.getBranch();
		expect(chooseCut(unfinished, 0, false)).toBe(unfinished.findIndex((entry) => entry.id === open) - 1);
		expect(() => chooseCut(branch.slice(0, at(first)), 0, false)).toThrow("CONTEXT_NO_CUT");
	});

	it("a branch that ends in a tool result compacts with the default budget and keeps its open turn", async () => {
		const store = manager(false);
		const original = seed(store);
		store.appendMessage({ role: "user", content: "Read the config file.", timestamp: 5 });
		store.appendMessage({
			...reply(),
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "service.json" } }],
			stopReason: "toolUse",
		});
		store.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: '{"port":4317}' }],
			isError: false,
			timestamp: 7,
		});
		const { session, runtime } = await sdk(store, { writerModel: "session" });
		vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(original))));
		await session.compact();
		expect(store.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
			"toolResult",
		]);
	});

	it("a positive keep budget keeps whole recent turns and never reaches back past the previous checkpoint", async () => {
		const store = manager(false);
		const original = seed(store);
		const { session, runtime } = await sdk(store, { writerModel: "session", keepRecentTokens: 1 });
		vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(original))));
		await session.compact();
		expect(store.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
		]);
		// The budget is far larger than the work since the checkpoint; the cut still stops at the checkpoint.
		store.appendMessage({ role: "user", content: "Small follow-up.", timestamp: 9 });
		store.appendMessage(reply());
		const branch = store.getBranch();
		const checkpointIndex = branch.findIndex((entry) => entry.type === "compaction");
		expect(chooseCut(branch, 50_000, false)).toBeGreaterThan(checkpointIndex);
		expect(branch[chooseCut(branch, 50_000, false)].type).toBe("message");
	});

	it("a catalogued fixed writer without provider authentication is unavailable", async () => {
		const store = manager(false);
		seed(store);
		const { runtime, agentDir } = await sdk(store);
		const controller = new MemoryController({
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "openai-codex/gpt-6-astra" },
			events: new EventLog(agentDir, false, "test-build"),
			runtime,
			session: store,
			setCompaction() {},
		});
		expect(runtime.getModel("openai-codex", "gpt-6-astra")).toBeDefined();
		expect(controller.writerStatus(model)).toEqual({ error: "CONTEXT_WRITER_UNAVAILABLE" });
	});

	it("configuration validates the new budgets and compactAt lowers the threshold", () => {
		const agentDir = fs.mkdtempSync(join(root, "agent-"));
		fs.writeFileSync(join(agentDir, "pi-context-memory.json"), JSON.stringify({ keepRecentTokens: -1 }));
		expect(() => readMemoryConfig(agentDir)).toThrow("CONTEXT_CONFIG");
		const valid = fs.mkdtempSync(join(root, "agent-"));
		fs.writeFileSync(
			join(valid, "pi-context-memory.json"),
			JSON.stringify({ writerModel: "session", keepRecentTokens: 4000, noteTokens: 2000, compactAt: 0.5 }),
		);
		const config = readMemoryConfig(valid);
		expect(config.writerModel).toBe("session");
		const budget = memoryBudget(model, config);
		expect(budget.threshold).toBe(64_000);
		expect(budget.noteTokens).toBe(2000);
		expect(budget.recentTokens).toBe(4000);
		expect(memoryBudget(model, { ...config, compactAt: 30_000 }).threshold).toBe(30_000);
		expect(memoryBudget({ ...model, contextWindow: 19_000 }).noteTokens).toBe(500);
		const fractional = fs.mkdtempSync(join(root, "agent-"));
		fs.writeFileSync(join(fractional, "pi-context-memory.json"), JSON.stringify({ compactAt: 1.5 }));
		expect(() => readMemoryConfig(fractional)).toThrow("CONTEXT_CONFIG");
		expect(memoryBudget(model).recentTokens).toBe(0);
		expect(memoryBudget(model).noteTokens).toBe(3000);
	});
});
