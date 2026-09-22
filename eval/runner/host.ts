import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import type { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { assertExecutionMode } from "../live/contract.ts";
import { reply, model as scriptedModel } from "../pi/offline-host.ts";
import { measuredRequest, type ProbeBudget, type RunMeter } from "./budget.ts";
import type { Arm, CallRecord, Transport } from "./types.ts";
import type { ProbeWorld } from "./world.ts";

export interface HostOptions {
	store: SessionManager;
	arm: Arm;
	nativeKeep: number;
	directory: string;
	transport: Transport;
	meter: RunMeter;
	purpose: "writer" | "task";
	records: CallRecord[];
	budget?: ProbeBudget;
	world?: ProbeWorld;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}
export async function createRunnerHost(options: HostOptions) {
	assertExecutionMode(options.transport.mode);
	const model = options.model ?? scriptedModel;
	mkdirSync(options.directory, { recursive: true });
	const agentDir = join(options.directory, "agent");
	mkdirSync(agentDir);
	const cwd = options.world?.cwd ?? join(options.directory, "workspace");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(agentDir, "pi-context-memory.json"), JSON.stringify({ enabled: options.arm === "project" }));
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "offline-evaluation-only" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	let lastError: string | undefined;
	const toolEvents: { tool: string; id: string; input: unknown; blocked?: string; isError?: boolean }[] = [];
	runtime.registerProvider(model.provider, {
		api: model.api,
		models: [model],
		apiKey: "offline-evaluation-only",
		streamSimple: (_model, context, requestOptions) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					const payload = await requestOptions?.onPayload?.(structuredClone(context), model);
					if (payload !== undefined && JSON.stringify(payload) !== JSON.stringify(context))
						throw new Error("EVAL_PAYLOAD_REWRITE_UNSUPPORTED");
					const message = await measuredRequest({
						transport: options.transport,
						purpose: options.purpose,
						context,
						model,
						maxTokens: requestOptions?.maxTokens ?? model.maxTokens,
						signal: requestOptions?.signal,
						reasoning: requestOptions?.reasoning,
						meter: options.meter,
						records: options.records,
						budget: options.budget,
						providerOptions: {
							toolChoice: requestOptions?.toolChoice,
							cacheRetention: requestOptions?.cacheRetention,
							sessionId: requestOptions?.sessionId,
							maxRetries: 0,
							transport: "sse",
						},
					});
					if (options.purpose === "task" && message.stopReason === "length") {
						options.records.at(-1)!.error = "EVAL_OUTPUT_TRUNCATED";
						throw new Error("EVAL_OUTPUT_TRUNCATED");
					}
					if (message.stopReason === "pending" || message.stopReason === "deferred")
						throw new Error("EVAL_NONTERMINAL_RESPONSE");
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						lastError = message.errorMessage ?? message.stopReason;
						stream.push({ type: "error", reason: message.stopReason, error: message });
					} else stream.push({ type: "done", reason: message.stopReason, message });
					stream.end(message);
				} catch (error) {
					lastError = String(error);
					const message = { ...reply(""), stopReason: "error" as const, errorMessage: lastError };
					stream.push({ type: "error", reason: "error", error: message });
					stream.end(message);
				}
			})();
			return stream;
		},
	});
	const boundaryGuard: ExtensionFactory = (pi) => {
		pi.on("session_before_compact", () => {
			if (options.purpose === "task") throw new Error("EVAL_UNDECLARED_COMPACTION");
		});
		pi.on("tool_call", (event) => {
			const blocked =
				options.budget?.error ??
				(event.toolName === "context_history" && "grantId" in event.input
					? "EVAL_HISTORY_GRANT_FORBIDDEN"
					: undefined);
			toolEvents.push({ tool: event.toolName, id: event.toolCallId, input: structuredClone(event.input), blocked });
			if (blocked) return { block: true, reason: blocked };
			return undefined;
		});
		pi.on("tool_result", (event) => {
			const item = [...toolEvents].reverse().find((tool) => tool.id === event.toolCallId);
			if (item) item.isError = event.isError;
		});
	};
	const settings = SettingsManager.inMemory({
		retry: { enabled: false },
		...(options.nativeKeep === 20000 ? {} : { compaction: { keepRecentTokens: options.nativeKeep } }),
	});
	const tools = [
		...(options.world ? ["read", "write", "task_action"] : []),
		...(options.arm === "project" ? ["context_history"] : []),
	];
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () =>
			"Continue the synthetic task using the recorded evidence and permissions. File tools expose only task.json (read-only) and scratch.txt in this task world. Use task_action for actual state changes.",
		extensionFactories: [boundaryGuard],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		thinkingLevel: options.thinkingLevel ?? "off",
		sessionManager: options.store,
		settingsManager: settings,
		resourceLoader: loader,
		tools,
		customTools: options.world?.tools(),
	});
	await session.bindExtensions({});
	session.setActiveToolsByName(tools);
	return { session, settings, agentDir, tools, toolEvents, error: () => lastError ?? options.budget?.error };
}
