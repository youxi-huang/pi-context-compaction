import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { prepareCompaction } from "../../packages/coding-agent/src/core/compaction/compaction.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import {
	type CompactionEntry,
	type SessionEntry,
	SessionManager,
} from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { createReadTool } from "../../packages/coding-agent/src/core/tools/read.ts";
import { createToolDefinitionFromAgentTool } from "../../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { createWriteTool } from "../../packages/coding-agent/src/core/tools/write.ts";
import {
	DEFAULT_MEMORY_CONFIG,
	memoryBudget,
	selectNoteBudget,
	textTokens,
} from "../../packages/coding-agent/src/extensions/context-memory/config.ts";
import { chooseCut } from "../../packages/coding-agent/src/extensions/context-memory/controller.ts";
import { EVENT_LOG_FILE, type MemoryEvent } from "../../packages/coding-agent/src/extensions/context-memory/events.ts";
import { freezeHistory, queryHistory } from "../../packages/coding-agent/src/extensions/context-memory/history.ts";
import { CONTEXT_KEEP_NONE, hashEntries } from "../../packages/coding-agent/src/extensions/context-memory/identity.ts";
import {
	compactedSourceTokens,
	latestMemory,
	type MemoryNote,
	noteBytes,
	renderNote,
	sourceText,
} from "../../packages/coding-agent/src/extensions/context-memory/notes.ts";

import { EVALUATED_RUNTIME_PIN as PIN } from "../runtime.ts";
const FUTURE = "FUTURE_SUFFIX_CANARY";
const GOLD = "EVALUATOR_GOLD_CANARY";
const model: Model<Api> = {
	id: "stage0-script",
	name: "Offline script",
	provider: "stage0-script",
	api: "openai-completions",
	baseUrl: "https://stage0.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
type Arm = "project" | "native";
function reply(text: string): AssistantMessage {
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
function call(name: string, args: Record<string, string | number>): AssistantMessage {
	return {
		...reply(""),
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }],
	};
}
function json(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function turn(index: number): Message[] {
	const prefix =
		index === 1
			? "Approved port: 4317. Keep the completed audit; only configure the service next. "
			: `Synthetic sizing record ${index}. `;
	// Exactly 999 + 1 source-proxy tokens per completed turn. Sizing only, not semantic evidence.
	return [{ role: "user", content: prefix.padEnd(2997, "x"), timestamp: index * 2 }, reply("OK.")];
}
function candidate(id: string): MemoryNote {
	return {
		instructions: [],
		failedPaths: [],
		reasons: [],
		files: [],
		gaps: [],
		state: [{ text: "Approved port: 4317. Audit already complete.", sources: [id], quote: "Approved port: 4317." }],
		nextSteps: [{ text: "Configure the service; preserve the completed audit.", sources: [id] }],
	};
}

/** Ordinary host tools with capability-limited operations: no content reads from the real filesystem. */
function toolEnvironment(cwd: string) {
	let state = JSON.stringify({ audit: "complete", service: "pending" });
	const trace: { action: string; path: string; content?: string }[] = [];
	const taskPath = join(cwd, "task.json");
	function allowed(path: string): void {
		if (resolve(path) !== taskPath) throw new Error("EVAL_TOOL_SCOPE");
	}
	const read = createReadTool(cwd, {
		operations: {
			access: async (path) => allowed(path),
			readFile: async (path) => {
				allowed(path);
				trace.push({ action: "read", path });
				return Buffer.from(state);
			},
		},
	});
	const write = createWriteTool(cwd, {
		operations: {
			mkdir: async (path) => {
				if (resolve(path) !== cwd) throw new Error("EVAL_TOOL_SCOPE");
			},
			writeFile: async (path, content) => {
				allowed(path);
				trace.push({ action: "write", path, content });
				state = content;
			},
		},
	});
	return { read, write, trace, state: () => state };
}

interface RequestCapture {
	at: number;
	phase: "writer" | "probe";
	context: Context;
}
async function host(store: SessionManager, arm: Arm, dir: string) {
	mkdirSync(dir, { recursive: true });
	const cwd = join(dir, "task");
	mkdirSync(cwd);
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir);
	json(join(agentDir, "pi-context-memory.json"), { enabled: arm === "project" });
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "offline-script-only" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	let phase: "writer" | "probe" = "writer";
	let firstSource = "";
	let probeCalls = 0;
	const captures: RequestCapture[] = [];
	runtime.registerProvider(model.provider, {
		api: model.api,
		apiKey: "offline-script-only",
		models: [model],
		streamSimple: (_model, context) => {
			captures.push({ at: performance.now(), phase, context: structuredClone(context) });
			let message: AssistantMessage;
			if (phase === "writer") {
				message = reply(
					arm === "project"
						? JSON.stringify(candidate(firstSource))
						: "Approved port: 4317. Audit already complete. Next: configure the service; preserve the audit.",
				);
			} else {
				probeCalls++;
				if (probeCalls > 5) throw new Error("EVAL_PROBE_CALL_LIMIT");
				const visible = JSON.stringify(context);
				const port = /Approved port: (\d+)/.exec(visible)?.[1];
				if (!port) throw new Error("EVAL_SCRIPT_MISSING_EVIDENCE");
				const step = probeCalls - (arm === "project" ? 1 : 0);
				if (step === 0) message = call("context_history", { operation: "search", query: "Approved port" });
				else if (step === 1) message = call("read", { path: "task.json" });
				else if (step === 2)
					message = call("write", {
						path: "task.json",
						content: JSON.stringify({ audit: "complete", service: "configured", port: Number(port) }),
					});
				else
					message = reply(
						JSON.stringify({ status: "complete", port: Number(port), evidence: `Approved port: ${port}.` }),
					);
			}
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			stream.end(message);
			return stream;
		},
	});
	const settings = SettingsManager.inMemory({ retry: { enabled: false } });
	const environment = toolEnvironment(cwd);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => "Continue the recorded task using its approved evidence and available tools.",
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		thinkingLevel: "off",
		sessionManager: store,
		settingsManager: settings,
		resourceLoader: loader,
		tools: ["read", "write", ...(arm === "project" ? ["context_history"] : [])],
		customTools: [
			createToolDefinitionFromAgentTool(environment.read),
			createToolDefinitionFromAgentTool(environment.write),
		],
	});
	await session.bindExtensions({});
	session.setActiveToolsByName(["read", "write", ...(arm === "project" ? ["context_history"] : [])]);
	return {
		session,
		settings,
		environment,
		captures,
		agentDir,
		writer: (id: string) => {
			phase = "writer";
			firstSource = id;
		},
		probe: () => {
			phase = "probe";
		},
	};
}

it("validates both real host paths, F1 trigger positions, reopened probes and tool isolation offline", async () => {
	expect(process.env.PI_OFFLINE).toBe("1");
	const output = process.env.STAGE0_ARTIFACT_DIR;
	if (!output || !output.startsWith("/"))
		throw new Error("STAGE0_ARTIFACT_DIR must be an absolute internal output directory");
	expect(
		execFileSync("git", ["diff", PIN, "--", "packages/coding-agent/src", "packages/ai/src", "packages/agent/src"], {
			encoding: "utf8",
		}),
	).toBe("");
	mkdirSync(output, { recursive: true });
	const root = mkdtempSync(join(output, "stage0-run-"));
	const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("EVAL_NETWORK_FORBIDDEN");
	});
	const stores = new Set<SessionManager>();
	const sessions = new Set<AgentSession>();
	const rows: Record<string, unknown>[] = [];
	const metadata = {
		host: PIN,
		upstream: "ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc",
		model,
		thinking: "off",
		writer: "session",
		noteRepair: true,
		realModelCalls: 0,
		measurementKind: "offline-scripted-interface-only",
		triggerTurns: [28, 30],
		sourceTokens: [28000, 30000],
		growthBeforeSecond: 2000,
		nativeKeepRecentTokens: 20000,
		projectKeepRecentTokens: 0,
	};
	json(join(root, "metadata.json"), { ...metadata, status: "running" });
	try {
		// Build a full synthetic source once, then physically exclude its future suffix from each initial arm.
		const source = SessionManager.create(root, root);
		stores.add(source);
		for (let i = 1; i <= 28; i++) for (const message of turn(i)) source.appendMessage(message);
		const firstSource = source.getBranch()[0].id;
		const prefix = readFileSync(source.getSessionFile()!, "utf8");
		for (let i = 29; i <= 30; i++) for (const message of turn(i)) source.appendMessage(message);
		const suffix = structuredClone(source.getBranch().slice(56));
		source.appendMessage({ role: "user", content: FUTURE, timestamp: 100 });
		source.appendMessage(reply("Future only."));
		writeFileSync(join(root, "full-source.jsonl"), readFileSync(source.getSessionFile()!));
		writeFileSync(join(root, "gold.json"), GOLD);
		source.close();
		stores.delete(source);
		for (const arm of ["project", "native"] as const) {
			const armDir = join(root, arm);
			mkdirSync(armDir);
			const file = join(armDir, "chain.jsonl");
			writeFileSync(file, prefix);
			let store = SessionManager.open(file, armDir);
			stores.add(store);
			for (const checkpoint of [1, 2]) {
				if (checkpoint === 2) {
					const lastCheckpoint = store.getLeafId();
					store.close();
					stores.delete(store);
					const continuation: SessionEntry[] = structuredClone(suffix);
					continuation[0].parentId = lastCheckpoint;
					writeFileSync(
						file,
						readFileSync(file, "utf8") + continuation.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
					);
					store = SessionManager.open(file, armDir);
					stores.add(store);
				}
				const setup = await host(store, arm, join(armDir, `checkpoint-${checkpoint}`));
				sessions.add(setup.session);
				setup.writer(firstSource);
				const branch = structuredClone(store.getBranch());
				const settings = setup.settings.getCompactionSettings(model);
				expect(settings.keepRecentTokens).toBe(arm === "native" ? 20000 : 0);
				const preparation = prepareCompaction(branch, settings);
				expect(preparation).toBeDefined();
				if (!preparation) throw new Error("EVAL_NO_PREPARATION");
				const active = new Set(store.buildContextEntries().map((entry) => entry.id));
				const cut =
					arm === "project"
						? chooseCut(branch, 0, false)
						: branch.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
				const released = branch.slice(0, cut).filter((entry) => active.has(entry.id) && sourceText(entry));
				const kept = branch.slice(cut).filter((entry) => active.has(entry.id) && sourceText(entry));
				const releasedTokens = compactedSourceTokens(released);
				expect(releasedTokens).toBe(
					arm === "project" ? (checkpoint === 1 ? 28000 : 2000) : checkpoint === 1 ? 1000 : 2000,
				);
				expect(compactedSourceTokens(branch)).toBe(checkpoint === 1 ? 28000 : 30000);
				const prior = latestMemory(branch);
				const previousTokens = prior ? textTokens(JSON.stringify(prior.memory.note)) : 0;
				const budget =
					arm === "project"
						? selectNoteBudget(
								DEFAULT_MEMORY_CONFIG,
								memoryBudget(model).threshold,
								releasedTokens,
								previousTokens,
							)
						: null;
				const expectedCut = arm === "project" && cut === branch.length ? CONTEXT_KEEP_NONE : branch[cut].id;
				const stem = `${arm}-checkpoint-${checkpoint}`;
				json(join(root, `${stem}-preparation.json`), {
					branch,
					preparation,
					cut,
					expectedCut,
					releasedIds: released.map((entry) => entry.id),
					keptIds: kept.map((entry) => entry.id),
					settings,
					budget,
				});
				const triggerAt = performance.now();
				const compacted = await setup.session.compact();
				const committedAt = performance.now();
				expect(compacted.firstKeptEntryId).toBe(expectedCut);
				const committed = store.getLeafEntry() as CompactionEntry;
				expect(committed.type).toBe("compaction");
				const memory = latestMemory(store.getBranch());
				if (arm === "project") {
					expect(memory?.memory.sourceHash).toBe(hashEntries(branch));
					expect(memory?.memory.coveredThrough).toBe(branch.at(-1)?.id);
					expect(memory?.memory.noteBudget).toEqual(budget);
					if (checkpoint === 2) expect(compacted.summary).toContain("priorCheckpoints");
				} else expect(memory).toBeUndefined();
				expect(JSON.stringify(setup.captures)).not.toContain(GOLD);
				expect(JSON.stringify(setup.captures)).not.toContain(FUTURE);
				expect(setup.captures).toHaveLength(1);
				json(join(root, `${stem}-writer-requests.json`), setup.captures);
				// Resume immediately on the committed chain to capture trigger / commit / next-request boundaries.
				const cleanCheckpoint = readFileSync(file, "utf8");
				const snapshot = join(armDir, `checkpoint-${checkpoint}.jsonl`);
				writeFileSync(snapshot, cleanCheckpoint);
				setup.probe();
				const dispatchAt = performance.now();
				await setup.session.prompt(
					"Continue: configure the service from the approved decision, preserving completed work.",
				);
				const immediateRequestAt = setup.captures.find((request) => request.phase === "probe")!.at;
				const immediateAnswer = setup.session.getLastAssistantText();
				setup.session.dispose();
				sessions.delete(setup.session);
				store.close();
				stores.delete(store);
				// Reopen an untouched checkpoint copy; the preceding probe never enters this history.
				const probeFile = join(armDir, `probe-${checkpoint}.jsonl`);
				copyFileSync(snapshot, probeFile);
				const probeStore = SessionManager.open(probeFile, armDir);
				stores.add(probeStore);
				expect(probeStore.getLeafId()).toBe(committed.id);
				expect(probeStore.getBranch().slice(0, branch.length)).toEqual(branch);
				const recovered = probeStore.buildSessionContext();
				expect(
					recovered.messages.some((message) => "summary" in message && message.summary === compacted.summary),
				).toBe(true);
				expect(readFileSync(probeFile, "utf8")).not.toContain(FUTURE);
				expect(
					queryHistory(freezeHistory(probeStore), { operation: "search", query: FUTURE }).entries,
				).toHaveLength(0);
				const probe = await host(probeStore, arm, join(armDir, `probe-host-${checkpoint}`));
				sessions.add(probe.session);
				probe.probe();
				expect(probe.environment.state()).toBe(JSON.stringify({ audit: "complete", service: "pending" }));
				const tools = probe.session.getActiveToolNames();
				expect(tools.sort()).toEqual(
					(arm === "project" ? ["context_history", "read", "write"] : ["read", "write"]).sort(),
				);
				for (const path of [
					join(root, "gold.json"),
					join(root, "full-source.jsonl"),
					file,
					"../task.json",
					join(root, arm === "project" ? "native" : "project", "chain.jsonl"),
				]) {
					await expect(probe.environment.read.execute("scope", { path })).rejects.toThrow("EVAL_TOOL_SCOPE");
					await expect(
						probe.environment.write.execute("scope", { path, content: "cross-copy change" }),
					).rejects.toThrow("EVAL_TOOL_SCOPE");
				}
				await probe.session.prompt(
					"Continue: configure the service from the approved decision, preserving completed work.",
				);
				const answer = JSON.parse(probe.session.getLastAssistantText()!);
				if (arm === "project") {
					const historyResult = probe.session.messages.find(
						(message) => message.role === "toolResult" && message.toolName === "context_history",
					);
					expect(JSON.stringify(historyResult)).toContain(firstSource);
					expect(JSON.stringify(historyResult)).toContain("Approved port: 4317.");
				}
				expect(answer).toEqual({ status: "complete", port: 4317, evidence: "Approved port: 4317." });
				expect(probe.session.getLastAssistantText()).toBe(immediateAnswer);
				expect(JSON.parse(probe.environment.state())).toEqual({
					audit: "complete",
					service: "configured",
					port: 4317,
				});
				expect(probe.environment.trace.map((action) => action.action)).toEqual(["read", "write"]);
				expect(readFileSync(snapshot, "utf8")).toBe(cleanCheckpoint);
				expect(readFileSync(join(root, "gold.json"), "utf8")).toBe(GOLD);
				const captured = JSON.stringify(probe.captures);
				expect(captured).not.toContain(GOLD);
				expect(captured).not.toContain(FUTURE);
				expect(captured).toContain(JSON.stringify(compacted.summary).slice(1, -1));
				json(join(root, `${stem}-probe.json`), {
					captures: probe.captures,
					tools,
					answer,
					trace: probe.environment.trace,
					finalState: JSON.parse(probe.environment.state()),
					score: { completed: 1, planned: 1, correct: 1, omitted: 0, blocked: 0 },
					firstAction: arm === "project" ? "context_history" : "read",
					duplicateCompletedActions: 0,
					violatedEarlyConstraints: 0,
					stopReason: "stop",
					isolationReadWriteAttempts: 10,
				});
				const eventRows: MemoryEvent[] =
					arm === "project"
						? readFileSync(join(setup.agentDir, EVENT_LOG_FILE), "utf8")
								.trim()
								.split("\n")
								.map((line) => JSON.parse(line) as MemoryEvent)
						: [];
				const event = eventRows.find((row) => row.event === "compaction");
				rows.push({
					arm,
					checkpoint,
					cumulativeSourceTokens: compactedSourceTokens(branch),
					releasedTokens,
					retainedTokens: compactedSourceTokens(kept),
					previousNoteJsonTokens: previousTokens,
					budget,
					capacityTruncationReason: null,
					previousNoteFloorEffective: false,
					repairUsed: event?.event === "compaction" ? event.repairUsed : null,
					firstKeptEntryId: compacted.firstKeptEntryId,
					coveredThrough: branch.at(-1)?.id,
					sourceHash: hashEntries(branch),
					noteJsonTokens: memory ? Math.ceil(noteBytes(memory.memory.note) / 3) : null,
					renderedNoteTokens: memory ? textTokens(renderNote(memory.memory.note)) : textTokens(compacted.summary),
					lineageTokens: event?.event === "compaction" ? event.lineageTokens : null,
					continuationTokens: event?.event === "compaction" ? event.continuationTokens : null,
					writerUsage: { kind: "scripted-placeholder", ...usage },
					realProviderUsage: null,
					writerCalls: setup.captures.filter((request) => request.phase === "writer").length,
					retrievalFollowupCalls: arm === "project" ? 1 : 0,
					triggerAt,
					committedAt,
					dispatchAt,
					immediateRequestAt,
					compactionMs: committedAt - triggerAt,
					orchestrationMs: dispatchAt - committedAt,
					rawBoundarySpanMs: immediateRequestAt - triggerAt,
					resumeRequestDelayMs: immediateRequestAt - dispatchAt,
					pauseMs: committedAt - triggerAt + immediateRequestAt - dispatchAt,
					writerOverheadRatio: null,
					writerOverheadFormula: "known real writer usage across all attempts / released source proxy tokens",
					recoveryFootprintRatio: (textTokens(compacted.summary) + compactedSourceTokens(kept)) / releasedTokens,
					recoveryFootprintFormula:
						"(rendered summary including lineage/continuation + retained source proxy) / released source proxy",
					event,
					result: "passed",
				});
				probe.session.dispose();
				sessions.delete(probe.session);
				probeStore.close();
				stores.delete(probeStore);
				// Continue only from the clean checkpoint, never from a probe-mutated branch.
				writeFileSync(file, cleanCheckpoint);
				store = SessionManager.open(file, armDir);
				stores.add(store);
			}
			store.close();
			stores.delete(store);
		}
		expect(fetchGuard).not.toHaveBeenCalled();
		json(join(root, "ledger.json"), {
			status: "passed",
			rows,
			actualModelCalls: 0,
			networkFetchCalls: fetchGuard.mock.calls.length,
			plannedCheckpoints: 4,
			attemptedCheckpoints: 4,
			committedCheckpoints: rows.length,
			plannedProbes: 8,
			completedProbes: 8,
			blockedProbes: 0,
			omittedProbes: 0,
			plannedReopenedProbes: 4,
			completedReopenedProbes: 4,
			immediateTimingProbes: 4,
			failures: [],
			unavailableMetrics: ["real provider usage", "cache reuse", "semantic recovery quality", "live latency"],
		});
		writeFileSync(
			join(root, "ledger.md"),
			`# Stage 0 interface gate\n\nOffline scripted checks passed. No provider quality claim.\n\n| Arm | Checkpoint | Cumulative source | Released | Retained | Tier |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows.map((row) => `| ${row.arm} | ${row.checkpoint} | ${row.cumulativeSourceTokens} | ${row.releasedTokens} | ${row.retainedTokens} | ${(row.budget as { tier: number } | null)?.tier ?? "n/a"} |`).join("\n")}\n`,
		);
		json(join(root, "metadata.json"), { ...metadata, status: "passed" });
		json(join(output, "stage0-latest.json"), { directory: root, status: "passed" });
	} catch (error) {
		json(join(root, "metadata.json"), { ...metadata, status: "failed" });
		json(join(root, "failure.json"), { status: "failed", error: String(error), rows, actualModelCalls: 0 });
		json(join(output, "stage0-latest.json"), { directory: root, status: "failed" });
		throw error;
	} finally {
		for (const session of sessions) session.dispose();
		for (const store of stores) store.close();
		fetchGuard.mockRestore();
	}
}, 60_000);
