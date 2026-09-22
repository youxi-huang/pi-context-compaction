import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import type { SessionEntry, SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { CONTEXT_MEMORY_BUILD } from "../../packages/coding-agent/src/extensions/context-memory/build.ts";
import {
	CONTEXT_KEEP_NONE,
	CONTEXT_MEMORY_KIND,
	CONTEXT_MEMORY_VERSION,
	hashEntries,
} from "../../packages/coding-agent/src/extensions/context-memory/identity.ts";
import {
	type MemoryNote,
	renderNote,
	sourceText,
} from "../../packages/coding-agent/src/extensions/context-memory/notes.ts";
import { assertFixture, type Fixture, type SourceRecord, validateMappings } from "../schema.ts";

export const model: Model<Api> = {
	id: "eval-script",
	name: "Offline evaluation script",
	provider: "eval-script",
	api: "openai-completions",
	baseUrl: "https://eval.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 256000,
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
export function reply(text: string): AssistantMessage {
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
export function note(source: string, text = "Recorded source remains available."): MemoryNote {
	return {
		instructions: [],
		failedPaths: [],
		reasons: [],
		state: [{ text, sources: [source] }],
		files: [],
		nextSteps: [],
		gaps: [],
	};
}
export function parseFixture(text: string, value: unknown) {
	assertFixture(value);
	const entries = text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const header = entries.shift();
	if (header.type !== "session" || header.version !== 3) throw new Error("EVAL_TRANSCRIPT_HEADER");
	const branch = entries as SessionEntry[];
	const records: SourceRecord[] = branch.map((entry) => ({
		id: entry.id,
		parentId: entry.parentId,
		role: entry.type === "message" ? entry.message.role : entry.type,
		text: sourceText(entry),
	}));
	validateMappings(value, records);
	return { header, branch, records, fixture: value as Fixture };
}
export function injectCheckpoint(store: SessionManager, candidate: MemoryNote) {
	const branch = store.getBranch();
	return store.appendCompaction(
		renderNote(candidate),
		CONTEXT_KEEP_NONE,
		10,
		{
			kind: CONTEXT_MEMORY_KIND,
			version: CONTEXT_MEMORY_VERSION,
			note: candidate,
			coveredThrough: store.getLeafId(),
			sourceHash: hashEntries(branch),
			snapshot: {
				sessionId: store.getSessionId(),
				leafId: store.getLeafId(),
				lastCheckpointId: [...branch].reverse().find((entry) => entry.type === "compaction")?.id ?? null,
			},
			writerModel: "scripted-candidate-injection",
			chunkCount: 1,
			build: CONTEXT_MEMORY_BUILD,
		},
		true,
	);
}
/** Only an offline test host, not the stage-2 general/live runner. */
export async function offlineHost(
	store: SessionManager,
	arm: "project" | "native",
	directory: string,
	candidate: MemoryNote,
	nativeKeep = 20000,
	compactAt?: number,
	systemPrompt = "Use the recorded evidence to continue the synthetic task.",
) {
	if (process.env.PI_OFFLINE !== "1" || process.env.EVAL_MODEL_CALL_BUDGET !== "0")
		throw new Error("EVAL_OFFLINE_REQUIRED");
	mkdirSync(directory, { recursive: true });
	const agentDir = join(directory, "agent");
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "pi-context-memory.json"),
		JSON.stringify({ enabled: arm === "project", ...(compactAt ? { compactAt } : {}) }),
	);
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "offline-only" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	let mode: "writer" | "task" = "writer";
	const requests: { mode: string; context: Context }[] = [];
	runtime.registerProvider(model.provider, {
		api: model.api,
		apiKey: "offline-only",
		models: [model],
		streamSimple: (_model, context) => {
			requests.push({ mode, context: structuredClone(context) });
			if (requests.length > 4) throw new Error("EVAL_SCRIPT_CALL_LIMIT");
			const message = reply(
				mode === "task"
					? "Scripted request captured."
					: arm === "project"
						? JSON.stringify(candidate)
						: "Scripted native summary; original source remains in the transcript.",
			);
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	});
	const settings = SettingsManager.inMemory({
		retry: { enabled: false },
		...(nativeKeep === 20000 ? {} : { compaction: { keepRecentTokens: nativeKeep } }),
	});
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir,
		modelRuntime: runtime,
		model,
		thinkingLevel: "off",
		sessionManager: store,
		settingsManager: settings,
		resourceLoader: loader,
		tools: arm === "project" ? ["context_history"] : [],
	});
	await session.bindExtensions({});
	return {
		session,
		settings,
		requests,
		agentDir,
		taskMode: () => {
			mode = "task";
		},
	};
}
