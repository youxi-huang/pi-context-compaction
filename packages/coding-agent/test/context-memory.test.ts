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
import { saveHistoryGrant } from "../src/extensions/context-memory/grant-file.ts";
import {
	freezeHistory,
	grantedHistory,
	issueHistoryGrant,
	queryHistory,
	revokeHistoryGrant,
} from "../src/extensions/context-memory/history.ts";
import { CONTEXT_MEMORY_KIND, hashEntries } from "../src/extensions/context-memory/identity.ts";
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
			extensions?: ExtensionFactory[];
			filter?: boolean;
			selectedModel?: Model<Api>;
		} = {},
	) {
		const agentDir = fs.mkdtempSync(join(root, "agent-"));
		fs.writeFileSync(
			join(agentDir, "pi-context-memory.json"),
			JSON.stringify({
				enabled: options.enabled ?? true,
				writerModel: "memory-test/memory-writer",
				writerEffort: "medium",
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

	it("a second compactor fails before either handler runs", async () => {
		const observer = vi.fn();
		await expect(
			sdk(manager(false), { extensions: [(pi) => pi.on("session_before_compact", observer)] }),
		).rejects.toThrow("CONTEXT_COMPACTOR_CONFLICT");
		expect(observer).not.toHaveBeenCalled();
	});

	it("two checkpoints retain raw-source coverage and latest decisions across reopen", async () => {
		const store = manager();
		const original = seed(store);
		const { session, runtime, settings } = await sdk(store);
		const calls = vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(original))));
		settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
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
		const { session, runtime, requests } = await sdk(store, { selectedModel: { ...model, contextWindow: 30_000 } });
		const writer = vi.spyOn(runtime, "completeSimple").mockRejectedValue(new Error("injected writer failure"));
		await session.prompt("Continue.");
		expect(requests()).toBe(0);
		expect(writer).toHaveBeenCalledTimes(1);
		expect(store.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("cancelled or stale candidates never publish", async () => {
		const store = manager(false);
		const id = seed(store);
		const { session, runtime, settings } = await sdk(store);
		let finish!: (response: AssistantMessage) => void;
		const writer = vi.spyOn(runtime, "completeSimple").mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
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
		const { session, runtime, settings } = await sdk(store);
		const writer = vi
			.spyOn(runtime, "completeSimple")
			.mockResolvedValue(reply(JSON.stringify(note(id, "Original source remains retrievable."))));
		settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
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
});
