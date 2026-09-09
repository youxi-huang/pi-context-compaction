import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { isRecord } from "./identity.ts";

/** The session model writes its own handover note; no second model is involved. */
export const SESSION_WRITER = "session";

export interface MemoryConfig {
	enabled: boolean;
	/** `session`, or a `provider/model` string resolved through the Pi model registry. */
	writerModel: string;
	writerEffort: ThinkingLevel;
	/** Append local evaluation events to `context-memory-events.jsonl` in the agent directory. Off when `enabled` is false. */
	eventLog: boolean;
	/** Original tokens kept after a compaction. 0 keeps nothing once the current turn is complete. */
	keepRecentTokens: number;
	/** Upper bound for the serialized note; also capped at 15% of the compaction threshold. */
	noteTokens: number;
	/** Automatic compaction point: a token count above 1, or a share of the context window at or below 1. */
	compactAt?: number;
}

const configs = new Map<string, Readonly<MemoryConfig>>();
const efforts: readonly string[] = ["minimal", "low", "medium", "high", "xhigh"];
export const DEFAULT_MEMORY_CONFIG: Readonly<Omit<MemoryConfig, "compactAt">> = Object.freeze({
	enabled: true,
	writerModel: SESSION_WRITER,
	writerEffort: "medium",
	eventLog: true,
	keepRecentTokens: 0,
	noteTokens: 3000,
});

function isCount(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

/** Configuration is latched once per agent directory and process, including across /reload. */
export function readMemoryConfig(agentDir: string): Readonly<MemoryConfig> {
	const path = join(resolve(agentDir), "pi-context-memory.json");
	const cached = configs.get(path);
	if (cached) return cached;
	const value: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	if (!isRecord(value)) throw new Error("CONTEXT_CONFIG: expected a JSON object");
	const config = {
		enabled: value.enabled ?? DEFAULT_MEMORY_CONFIG.enabled,
		writerModel: value.writerModel ?? DEFAULT_MEMORY_CONFIG.writerModel,
		writerEffort: value.writerEffort ?? DEFAULT_MEMORY_CONFIG.writerEffort,
		eventLog: value.eventLog ?? DEFAULT_MEMORY_CONFIG.eventLog,
		keepRecentTokens: value.keepRecentTokens ?? DEFAULT_MEMORY_CONFIG.keepRecentTokens,
		noteTokens: value.noteTokens ?? DEFAULT_MEMORY_CONFIG.noteTokens,
		...(value.compactAt === undefined ? {} : { compactAt: value.compactAt }),
	};
	if (
		typeof config.enabled !== "boolean" ||
		typeof config.eventLog !== "boolean" ||
		typeof config.writerModel !== "string" ||
		!(config.writerModel === SESSION_WRITER || config.writerModel.includes("/")) ||
		typeof config.writerEffort !== "string" ||
		!efforts.includes(config.writerEffort)
	) {
		throw new Error("CONTEXT_CONFIG: invalid enabled, eventLog, writerModel or writerEffort");
	}
	if (!isCount(config.keepRecentTokens, 0) || !isCount(config.noteTokens, 500))
		throw new Error("CONTEXT_CONFIG: keepRecentTokens must be an integer >= 0 and noteTokens an integer >= 500");
	if (
		config.compactAt !== undefined &&
		!(
			typeof config.compactAt === "number" &&
			Number.isFinite(config.compactAt) &&
			config.compactAt > 0 &&
			(config.compactAt <= 1 || Number.isInteger(config.compactAt))
		)
	)
		throw new Error("CONTEXT_CONFIG: compactAt must be an integer token count above 1 or a window share in (0, 1]");
	const result = Object.freeze(config as MemoryConfig);
	configs.set(path, result);
	return result;
}

export interface MemoryBudget {
	capacity: number;
	reserve: number;
	/** Automatic compaction point and the input allowance for every request. */
	threshold: number;
	noteTokens: number;
	recentTokens: number;
}

export function memoryBudget(
	model: Model<Api>,
	config: Pick<MemoryConfig, "keepRecentTokens" | "noteTokens" | "compactAt"> = DEFAULT_MEMORY_CONFIG,
): MemoryBudget {
	const capacity = model.contextWindow;
	if (!Number.isFinite(capacity) || capacity < 4096)
		throw new Error("CONTEXT_CAPACITY: model window is too small or unknown");
	const reserve = Math.max(16_384, model.maxTokens || 0);
	const cap = /gemini/i.test(model.id) ? 200_000 : /^gpt(?:-|$)/i.test(model.id) ? 400_000 : Infinity;
	const requested =
		config.compactAt === undefined
			? Infinity
			: config.compactAt <= 1
				? capacity * config.compactAt
				: config.compactAt;
	const threshold = Math.floor(Math.min(cap, capacity * 0.8, capacity - reserve, requested));
	if (threshold < 2048) throw new Error("CONTEXT_CAPACITY: output reserve leaves no usable input window");
	return {
		capacity,
		reserve,
		threshold,
		noteTokens: Math.max(500, Math.min(config.noteTokens, Math.floor(threshold * 0.15))),
		recentTokens: Math.min(config.keepRecentTokens, Math.floor(threshold * 0.5)),
	};
}

/** Conservative text estimate. Provider usage remains the authoritative billing measure. */
export function textTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}
