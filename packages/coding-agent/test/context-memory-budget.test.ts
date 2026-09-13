import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	type MemoryConfig,
	readMemoryConfig,
	selectNoteBudget,
	storedNoteLimit,
} from "../src/extensions/context-memory/config.ts";
import { MemoryController } from "../src/extensions/context-memory/controller.ts";
import { EventLog, type MemoryEvent } from "../src/extensions/context-memory/events.ts";
import {
	compactedSourceTokens,
	latestMemory,
	type MemoryNote,
	noteBytes,
	validateNote,
} from "../src/extensions/context-memory/notes.ts";
import { type WriterProgress, writeMemory } from "../src/extensions/context-memory/writer.ts";

const model: Model<Api> = {
	id: "gpt-memory-budget",
	name: "Budget fixture",
	provider: "memory-budget",
	api: "openai-completions",
	baseUrl: "https://memory.invalid",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1_050_000,
	maxTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
	input: 12,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function reply(text = "Done."): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 1,
		usage,
	};
}
function note(id: string, characters = 30): MemoryNote {
	const state = [];
	for (let left = characters; left > 0; left -= 4000)
		state.push({ text: "界".repeat(Math.min(left, 4000)), sources: [id] });
	return { instructions: [], failedPaths: [], reasons: [], state, nextSteps: [], files: [], gaps: [] };
}

describe("tiered note budgets and bounded size repair", () => {
	let root: string;
	const sessions: AgentSession[] = [];
	const managers: SessionManager[] = [];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-note-budget-"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) session.dispose();
		for (const manager of managers.splice(0)) manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	async function setup(
		config: Partial<MemoryConfig> = {},
		source = "Do not deploy. Use port 4317, not 9000. File: /workspace/项目/config.json.",
		selectedModel = model,
	) {
		const agentDir = mkdtempSync(join(root, "agent-"));
		writeFileSync(join(agentDir, "pi-context-memory.json"), JSON.stringify({ writerModel: "session", ...config }));
		const store = SessionManager.create(root, root);
		managers.push(store);
		const id = store.appendMessage({ role: "user", content: source, timestamp: 1 });
		store.appendMessage(reply());
		const credentials = AuthStorage.inMemory();
		await credentials.modify(model.provider, async () => ({ type: "api_key", key: "fake-test-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		runtime.registerProvider(model.provider, {
			api: model.api,
			apiKey: "fake-test-key",
			models: [selectedModel, { ...model, id: "fixed-writer", contextWindow: 128_000 }],
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				const result = reply();
				stream.push({ type: "done", reason: "stop", message: result });
				stream.end(result);
				return stream;
			},
		});
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "Use authorized evidence only.",
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			modelRuntime: runtime,
			model: selectedModel,
			sessionManager: store,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
			resourceLoader: loader,
		});
		sessions.push(session);
		await session.bindExtensions({});
		const events = () =>
			readFileSync(join(agentDir, "context-memory-events.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as MemoryEvent)
				.filter((event) => event.event === "compaction");
		return { store, id, runtime, session, agentDir, events };
	}

	it.each([
		[0, 1, 3000, 4000],
		[50_000, 1, 3000, 4000],
		[80_000, 1, 3000, 4000],
		[80_001, 2, 4000, 5000],
		[200_000, 2, 4000, 5000],
		[200_001, 3, 5000, 6000],
		[250_000, 3, 5000, 6000],
		[400_000, 3, 5000, 6000],
		[400_001, 4, 6000, 8000],
		[1_000_000, 4, 6000, 8000],
	])("source %i selects tier %i with %i/%i budget", (size, tier, base, hard) => {
		expect(selectNoteBudget({}, 400_000, size)).toMatchObject({
			mode: "tiered",
			tier,
			baseTokens: base,
			hardTokens: hard,
		});
	});

	it("explicit settings remain fixed, small windows cap tiers, and the floor follows actual note size rather than historical tier", () => {
		expect(selectNoteBudget({ noteTokens: 2000 }, 400_000, 500_000, 7000)).toMatchObject({
			mode: "fixed",
			tier: 0,
			baseTokens: 2000,
			hardTokens: 2000,
		});
		expect(selectNoteBudget({}, 10_000, 250_000, 7000)).toMatchObject({ baseTokens: 1500, hardTokens: 1500 });
		expect(selectNoteBudget({}, 2048, 250_000)).toMatchObject({ baseTokens: 500, hardTokens: 500 });
		expect(selectNoteBudget({}, 400_000, 100, 7000)).toMatchObject({ tier: 1, baseTokens: 6300, hardTokens: 7000 });
		expect(selectNoteBudget({}, 400_000, 100, 3100)).toMatchObject({ baseTokens: 3000, hardTokens: 4000 });
		expect(selectNoteBudget({ noteTokens: 30_000 }, 400_000, 100).hardTokens).toBe(8000);
	});

	it("configuration omission selects tiers, explicit noteTokens is retained, and repair is restart-latched", () => {
		const dir = join(root, "config");
		// mkdtemp provides the directory without involving a session.
		const path = mkdtempSync(dir);
		writeFileSync(join(path, "pi-context-memory.json"), JSON.stringify({ noteTokens: 3500, noteRepair: false }));
		const config = readMemoryConfig(path);
		expect(config).toMatchObject({ noteTokens: 3500, noteRepair: false });
		writeFileSync(join(path, "pi-context-memory.json"), "{}");
		expect(readMemoryConfig(path)).toBe(config);
		expect(readMemoryConfig(mkdtempSync(dir))).toMatchObject({ noteRepair: true });
		expect(readMemoryConfig(mkdtempSync(dir)).noteTokens).toBeUndefined();
		const bad = mkdtempSync(dir);
		writeFileSync(join(bad, "pi-context-memory.json"), '{"noteRepair":"yes"}');
		expect(() => readMemoryConfig(bad)).toThrow("CONTEXT_CONFIG");
	});

	it("source sizing ignores image bytes, hidden thinking signatures and checkpoint text", async () => {
		const { store } = await setup();
		const before = compactedSourceTokens(store.getBranch());
		store.appendMessage({
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: "A".repeat(900_000) }],
			timestamp: 2,
		});
		store.appendMessage({
			...reply(),
			content: [{ type: "thinking", thinking: "private".repeat(100_000), thinkingSignature: "A".repeat(900_000) }],
		});
		expect(compactedSourceTokens(store.getBranch()) - before).toBeLessThan(100);
	});

	it("a 250k source uses tier 3 on its first writer call, then shrinks without inheriting that tier", async () => {
		const { store, id, runtime, session, events } = await setup({}, "界".repeat(250_000));
		const writer = vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(id, 3200))));
		await session.compact();
		expect(writer).toHaveBeenCalledTimes(1);
		expect(events()[0]).toMatchObject({
			outcome: "committed",
			budgetPolicy: { tier: 3, baseTokens: 5000, hardTokens: 6000 },
			repairUsed: false,
			elasticUsed: false,
		});
		const instruction = JSON.stringify(writer.mock.calls[0][1].messages.at(-1));
		expect(instruction).toContain("18000 UTF-8 bytes");
		expect(instruction).toContain("Preferred ceiling: 15000 bytes");
		expect(instruction).toContain("not a new user task or ruling");
		expect(instruction).toContain("neither completes nor cancels the original task");
		expect(instruction).not.toContain("Stop the task now");
		store.appendMessage({ role: "user", content: "Continue.", timestamp: 3 });
		store.appendMessage(reply());
		await session.compact();
		expect(events()[1].budgetPolicy).toMatchObject({ tier: 1, hardTokens: 4000 });
		expect(events()[1].budgetPolicy!.sourceTokens).toBeLessThan(100);
	});

	it("elastic acceptance costs no repair, while retained latest-turn text does not inflate the tier", async () => {
		const { store, id, runtime, session, events } = await setup({ keepRecentTokens: 100 });
		store.appendMessage({ role: "user", content: "界".repeat(250_000), timestamp: 3 });
		store.appendMessage(reply());
		const writer = vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(id, 3200))));
		await session.compact();
		expect(events()[0]).toMatchObject({
			elasticUsed: true,
			repairUsed: false,
			budgetPolicy: { tier: 1, baseTokens: 3000, hardTokens: 4000 },
		});
		expect(events()[0].budgetPolicy!.sourceTokens).toBeLessThan(100);
		expect(writer).toHaveBeenCalledTimes(1);
	});

	it.each(["session", "memory-budget/fixed-writer"])(
		"%s repairs only size once, with a short same-model request and per-call accounting",
		async (writerModel) => {
			const { id, runtime, session, events } = await setup({ writerModel, noteTokens: 1000 });
			const candidate = note(id, 1700);
			candidate.instructions = [{ text: "No deployment.", sources: [id], quote: "Do not deploy." }];
			const repaired = note(id);
			repaired.instructions = candidate.instructions;
			const writer = vi
				.spyOn(runtime, "completeSimple")
				.mockResolvedValueOnce(reply(JSON.stringify(candidate)))
				.mockResolvedValueOnce(reply(JSON.stringify(repaired)));
			await session.compact();
			expect(writer).toHaveBeenCalledTimes(2);
			expect(writer.mock.calls[1][0]).toBe(writer.mock.calls[0][0]);
			expect(writer.mock.calls[1][1].messages).toHaveLength(1);
			expect(writer.mock.calls[1][1].tools).toEqual([]);
			expect(writer.mock.calls[1][1].systemPrompt).toContain("only size-repair attempt");
			expect(writer.mock.calls[1][2]).toMatchObject({ maxRetries: 0, toolChoice: "none" });
			expect(events()[0]).toMatchObject({
				outcome: "committed",
				writerCalls: 2,
				usageReports: 2,
				repairUsed: true,
				noteJsonBytes: noteBytes(repaired),
				usage: { totalTokens: 40 },
			});
			expect(events()[0].writerCallDetails).toMatchObject([
				{ phase: "generate", noteBytes: noteBytes(candidate), usage: { totalTokens: 20 } },
				{ phase: "repair", noteBytes: noteBytes(repaired), usage: { totalTokens: 20 } },
			]);
		},
	);

	it.each(["disabled", "still-large", "invalid", "quote", "anchor-loss", "network", "cancel", "changed-source"])(
		"repair failure %s preserves the original file and never commits",
		async (kind) => {
			const { id, store, runtime, session, events } = await setup({
				noteTokens: 1000,
				noteRepair: kind !== "disabled",
			});
			const candidate = note(id, 1700);
			candidate.instructions = [{ text: "No deployment.", sources: [id], quote: "Do not deploy." }];
			const repaired = note(id);
			repaired.instructions = candidate.instructions;
			const before = readFileSync(store.getSessionFile()!, "utf8");
			const writer = vi
				.spyOn(runtime, "completeSimple")
				.mockResolvedValueOnce(reply(JSON.stringify(candidate)))
				.mockImplementationOnce(async () => {
					if (kind === "network") throw new Error("HTTP 503");
					if (kind === "cancel") {
						session.abortCompaction();
						return reply(JSON.stringify(repaired));
					}
					if (kind === "changed-source")
						store.appendMessage({ role: "user", content: "New ruling.", timestamp: 3 });
					if (kind === "quote")
						repaired.instructions[0] = { ...repaired.instructions[0], quote: "Invented quote" };
					if (kind === "anchor-loss") repaired.instructions = [];
					return reply(
						kind === "invalid" ? "not JSON" : JSON.stringify(kind === "still-large" ? candidate : repaired),
					);
				});
			await expect(session.compact()).rejects.toThrow();
			expect(writer).toHaveBeenCalledTimes(kind === "disabled" ? 1 : 2);
			expect(latestMemory(store.getBranch())).toBeUndefined();
			if (kind !== "changed-source") expect(readFileSync(store.getSessionFile()!, "utf8")).toBe(before);
			expect(events()[0].outcome).not.toBe("committed");
			expect(events()[0].usageReports).toBe(kind === "network" || kind === "disabled" ? 1 : 2);
			await expect(session.extensionRunner.emitBeforeProviderRequest({})).rejects.toThrow("CONTEXT_BLOCKED");
			// An explicit retry is a new attempt; failure must not poison storage.
			writer.mockResolvedValue(reply(JSON.stringify(note(id))));
			await session.compact();
			expect(events().at(-1)!.outcome).toBe("committed");
		},
	);

	it.each(["bad-quote", "bad-source", "bad-schema", "missing-next-step"])(
		"%s never becomes eligible for a size repair",
		async (kind) => {
			const { store, id, runtime, agentDir } = await setup({ noteTokens: 1000 });
			const candidate = note(id, 1700);
			if (kind === "bad-quote") candidate.state[0].quote = "Not in original";
			if (kind === "bad-source") candidate.state[0].sources = ["missing"];
			if (kind === "bad-schema") candidate.state = [];
			const writer = vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(candidate)));
			await expect(
				writeMemory({
					config: readMemoryConfig(agentDir),
					runtime,
					sessionModel: model,
					prefix: { systemPrompt: "task", messages: [], tools: [] },
					uncovered: store.getBranch(),
					branch: store.getBranch(),
					increments: [],
					noteTokens: 1000,
					signal: new AbortController().signal,
					...(kind === "missing-next-step" ? { activeRequests: [store.getBranch()[0]] } : {}),
				}),
			).rejects.toThrow(/CONTEXT_(NOTE|CONTINUATION)/);
			expect(writer).toHaveBeenCalledTimes(1);
		},
	);

	it("the fixed writer shares a single repair allowance across all chunks", async () => {
		const { store, id, runtime, agentDir } = await setup(
			{ writerModel: "memory-budget/fixed-writer", noteTokens: 1000 },
			"界".repeat(90_000),
		);
		const candidate = note(id, 1700);
		const writer = vi
			.spyOn(runtime, "completeSimple")
			.mockResolvedValueOnce(reply(JSON.stringify(candidate)))
			.mockResolvedValueOnce(reply(JSON.stringify(note(id))))
			.mockResolvedValueOnce(reply(JSON.stringify(candidate)));
		const progress: WriterProgress[] = [];
		await expect(
			writeMemory({
				config: readMemoryConfig(agentDir),
				runtime,
				uncovered: store.getBranch(),
				branch: store.getBranch(),
				increments: [],
				noteTokens: 1000,
				signal: new AbortController().signal,
				onProgress: (value) => progress.push(value),
			}),
		).rejects.toThrow("CONTEXT_NOTE_BUDGET");
		expect(writer).toHaveBeenCalledTimes(3);
		expect(progress.at(-1)!.writerCallDetails.map((call) => call.phase)).toEqual(["generate", "repair", "generate"]);
		expect(progress.at(-1)!.usage!.totalTokens).toBe(60);
	});

	it("notes above 6000 publish, cold-open, fork, retrieve and survive smaller generation settings", async () => {
		const { store, id, runtime, session, events, agentDir } = await setup({}, "界".repeat(410_000));
		const large = note(id, 6600);
		vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(large)));
		await session.compact();
		expect(events()[0]).toMatchObject({ elasticUsed: true, budgetPolicy: { tier: 4, hardTokens: 8000 } });
		const file = store.getSessionFile()!;
		session.dispose();
		store.close();
		const worker = fileURLToPath(new URL("./fixtures/context-memory-budget-worker.ts", import.meta.url));
		const result = JSON.parse(
			execFileSync(process.execPath, ["--experimental-strip-types", worker, file, id], {
				encoding: "utf8",
				env: { ...process.env, PI_OFFLINE: "1" },
			}),
		);
		expect(result).toMatchObject({ hardTokens: 8000, retrieved: id, forked: true });
		const reopened = SessionManager.open(file);
		managers.push(reopened);
		const changed = { ...readMemoryConfig(agentDir), noteTokens: 1000 };
		const controller = new MemoryController({
			config: changed,
			runtime,
			session: reopened,
			events: new EventLog(undefined, false, "test"),
			setCompaction() {},
		});
		controller.refresh({ ...model, contextWindow: 128_000 });
		expect(controller.status()).toMatchObject({
			state: "ready",
			noteBudgetMode: "fixed",
			checkpointBudget: { hardTokens: 8000 },
		});
		expect(latestMemory(reopened.getBranch())!.memory.note).toEqual(large);
	});

	it("stored limits reject tampering, legacy checkpoints keep 6000, and quoted notes stay strict", async () => {
		expect(storedNoteLimit(undefined)).toBe(6000);
		const policy = selectNoteBudget({}, 400_000, 500_000);
		for (const mutation of [
			{ hardTokens: 9000 },
			{ baseTokens: 9000 },
			{ version: 2 },
			{ tier: 0 },
			{ sourceTokens: -1 },
			{ hardTokens: "8000" },
		])
			expect(() => storedNoteLimit({ ...policy, ...mutation })).toThrow("CONTEXT_NOTE_VERSION");
		const { store, id, runtime, session } = await setup();
		vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(id))));
		await session.compact();
		const branch = structuredClone(store.getBranch());
		const checkpoint = branch.at(-1)!;
		if (checkpoint.type !== "compaction") throw new Error("Expected checkpoint");
		const memory = latestMemory(branch)!.memory;
		delete memory.noteBudget;
		expect(latestMemory(branch)!.memory.note).toEqual(note(id));
		memory.noteBudget = { ...policy, hardTokens: 9000 };
		expect(() => latestMemory(branch)).toThrow("CONTEXT_NOTE_VERSION");
		const invalid = note(id, 1700);
		invalid.state[0].quote = "Invented";
		expect(() => validateNote(invalid, store.getBranch(), 1000)).toThrow("CONTEXT_NOTE_QUOTE");
	});

	it("reviewed-copy migration accepts a stored large budget and still accepts legacy candidates", async () => {
		const { store, id, session } = await setup();
		const source = store.getSessionFile()!;
		const original = readFileSync(source);
		const leaf = store.getLeafId();
		session.dispose();
		store.close();
		const script = fileURLToPath(new URL("../../../scripts/context-memory-migrate.mjs", import.meta.url));
		for (const legacy of [false, true]) {
			const candidate = join(root, `candidate-${legacy}.json`);
			const output = join(root, `migrated-${legacy}.jsonl`);
			const expected = note(id, legacy ? 100 : 6500);
			writeFileSync(
				candidate,
				JSON.stringify({
					version: 1,
					source,
					sourceSha256: createHash("sha256").update(original).digest("hex"),
					sourceLeaf: leaf,
					writerModel: "memory-budget/fixed-writer",
					chunkCount: 1,
					build: "test",
					note: expected,
					...(legacy ? {} : { noteBudget: selectNoteBudget({ noteTokens: 7000 }, 400_000, 100) }),
				}),
			);
			const result = JSON.parse(
				execFileSync(process.execPath, [script, "--commit", candidate, "--reviewed", "--output", output], {
					encoding: "utf8",
					env: { ...process.env, PI_OFFLINE: "1" },
				}),
			);
			expect(result).toMatchObject({ originalChanged: false, modelCalls: 0 });
			const reopened = SessionManager.open(output);
			managers.push(reopened);
			expect(latestMemory(reopened.getBranch())!.memory.note).toEqual(expected);
		}
		expect(readFileSync(source)).toEqual(original);
	});

	it("a repair payload above its bounded window is refused before a second paid call", async () => {
		const { store, id, runtime, agentDir } = await setup({ noteTokens: 1000 });
		const writer = vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(id, 100_000))));
		await expect(
			writeMemory({
				config: readMemoryConfig(agentDir),
				runtime,
				sessionModel: model,
				prefix: { systemPrompt: "task", messages: [], tools: [] },
				uncovered: store.getBranch(),
				branch: store.getBranch(),
				increments: [],
				noteTokens: 1000,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("CONTEXT_WRITER_CAPACITY");
		expect(writer).toHaveBeenCalledTimes(1);
	});

	it("successive manual checkpoints retain source anchors and use the preceding note size after a model switch", async () => {
		const { store, id, runtime, session, events } = await setup({}, "界".repeat(250_000));
		const first = note(id, 5500);
		vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(first)));
		await session.compact();
		const previousTokens = Math.ceil(noteBytes(first) / 3);
		store.appendMessage({ role: "user", content: "Continue the pending report; do not deploy.", timestamp: 3 });
		store.appendMessage(reply());
		await session.setModel({ ...model, contextWindow: 128_000 });
		await session.compact();
		expect(events()[1].budgetPolicy).toMatchObject({
			tier: 1,
			previousTokens,
			baseTokens: Math.ceil(previousTokens * 0.9),
			hardTokens: previousTokens,
		});
		expect(latestMemory(store.getBranch())!.memory.note.state[0].sources).toContain(id);
		const controller = new MemoryController({
			config: readMemoryConfig(mkdtempSync(join(root, "status-"))),
			runtime,
			session: store,
			events: new EventLog(undefined, false, "test"),
			setCompaction() {},
		});
		controller.refresh(model);
		expect(controller.status().checkpointBudget).toEqual(events()[1].budgetPolicy);
	});

	it("reports JSON budget usage separately and never invents measurements for old logs", async () => {
		const { id, runtime, session, events, agentDir } = await setup();
		vi.spyOn(runtime, "completeSimple").mockResolvedValue(reply(JSON.stringify(note(id, 3200))));
		await session.compact();
		const event = events()[0];
		const legacy = {
			...event,
			session: "legacy",
			noteJsonBytes: undefined,
			budgetPolicy: undefined,
			writerCallDetails: undefined,
			repairUsed: undefined,
		};
		const file = join(agentDir, "context-memory-events.jsonl");
		writeFileSync(file, `${JSON.stringify(event)}\n${JSON.stringify(legacy)}\n`);
		const script = fileURLToPath(new URL("../../../scripts/context-memory-report.mjs", import.meta.url));
		const report = JSON.parse(
			execFileSync(process.execPath, [script, "--file", file, "--json"], { encoding: "utf8" }),
		);
		expect(report.tokens).toMatchObject({
			noteBudgetMeasured: 1,
			noteBudgetUnknown: 1,
			noteBudgetShare: Number((noteBytes(note(id, 3200)) / 12_000).toFixed(2)),
		});
		expect(report.writerAttempts.attemptsWithoutPhaseDetails).toBe(1);
		expect(report.budgets.byMode).toEqual({ tiered: 1, unknown: 1 });
		expect(report.writerAttempts.byPhase.generate.tokens).toBe(20);
		expect(report.writerAttempts.all.tokens).toBe(40);
	});
});
