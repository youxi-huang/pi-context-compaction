import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { isRecord } from "./identity.ts";

export interface MemoryConfig {
	enabled: boolean;
	writerModel: string;
	writerEffort: ThinkingLevel;
	/** Append local evaluation events to `context-memory-events.jsonl` in the agent directory. Off when `enabled` is false. */
	eventLog: boolean;
}

const configs = new Map<string, Readonly<MemoryConfig>>();
const efforts: readonly string[] = ["minimal", "low", "medium", "high", "xhigh"];

/** Configuration is latched once per agent directory and process, including across /reload. */
export function readMemoryConfig(agentDir: string): Readonly<MemoryConfig> {
	const path = join(resolve(agentDir), "pi-context-memory.json");
	const cached = configs.get(path);
	if (cached) return cached;
	const value: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	if (!isRecord(value)) throw new Error("CONTEXT_CONFIG: expected a JSON object");
	const config = {
		enabled: value.enabled ?? true,
		writerModel: value.writerModel ?? "openai-codex/gpt-6-astra",
		writerEffort: value.writerEffort ?? "medium",
		eventLog: value.eventLog ?? true,
	};
	if (
		typeof config.enabled !== "boolean" ||
		typeof config.eventLog !== "boolean" ||
		typeof config.writerModel !== "string" ||
		!config.writerModel.includes("/") ||
		typeof config.writerEffort !== "string" ||
		!efforts.includes(config.writerEffort)
	) {
		throw new Error("CONTEXT_CONFIG: invalid enabled, eventLog, writerModel or writerEffort");
	}
	const result = Object.freeze(config as MemoryConfig);
	configs.set(path, result);
	return result;
}

export function memoryBudget(model: Model<Api>) {
	const capacity = model.contextWindow;
	if (!Number.isFinite(capacity) || capacity < 4096)
		throw new Error("CONTEXT_CAPACITY: model window is too small or unknown");
	const reserve = Math.max(16_384, model.maxTokens || 0);
	const cap = /gemini/i.test(model.id) ? 200_000 : /^gpt(?:-|$)/i.test(model.id) ? 400_000 : Infinity;
	const threshold = Math.floor(Math.min(cap, capacity * 0.8, capacity - reserve));
	if (threshold < 2048) throw new Error("CONTEXT_CAPACITY: output reserve leaves no usable input window");
	return {
		capacity,
		reserve,
		threshold,
		noteTokens: Math.min(6000, Math.floor(threshold * 0.15)),
		recentTokens: Math.min(20_000, Math.floor(threshold * 0.5)),
	};
}

/** Conservative text estimate. Provider usage remains the authoritative billing measure. */
export function textTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}
