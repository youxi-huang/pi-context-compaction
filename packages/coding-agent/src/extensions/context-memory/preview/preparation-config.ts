import { join } from "node:path";
import { isRecord } from "../identity.ts";
import { missing, readBoundedFile } from "./failure-io.ts";
import type { PreparationLedgerPolicy } from "./preparation-ledger.ts";

export interface PreviewPreparationConfig {
	enabled: boolean;
	minSourceTokens: number;
	minIntervalMs: number;
	deadlineMs: number;
	maxCallsPerAttempt: number;
	ledger: PreparationLedgerPolicy;
}

export const DEFAULT_PREPARATION_CONFIG: Readonly<PreviewPreparationConfig> = Object.freeze({
	enabled: false,
	minSourceTokens: 2048,
	minIntervalMs: 5000,
	deadlineMs: 120_000,
	maxCallsPerAttempt: 8,
	ledger: Object.freeze({
		maxAttemptsPerInterval: 1,
		maxCallsPerInterval: 8,
		maxCallsPerSession: 16,
		maxReservedTokensPerInterval: 1_200_000,
		maxReservedTokensPerSession: 2_400_000,
		maxReservedCostMicrosPerInterval: 1_000_000,
		maxReservedCostMicrosPerSession: 2_000_000,
		maxDetails: 64,
	}),
});

export interface PreparationConfigResult {
	config: Readonly<PreviewPreparationConfig>;
	error?: "invalid-config";
}

const cached = new Map<string, PreparationConfigResult>();

function count(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

/** Only preview-local optional work uses these settings; shared memory policy is unchanged. */
export function parsePreparationConfig(value: unknown): PreparationConfigResult {
	const disabled = (): PreparationConfigResult => ({ config: DEFAULT_PREPARATION_CONFIG, error: "invalid-config" });
	if (value === undefined) return { config: DEFAULT_PREPARATION_CONFIG };
	if (!isRecord(value)) return disabled();
	const allowed = ["enabled", "minSourceTokens", "minIntervalMs", "deadlineMs", "maxCallsPerAttempt", "ledger"];
	if (Object.keys(value).some((key) => !allowed.includes(key))) return disabled();
	const merged = { ...DEFAULT_PREPARATION_CONFIG, ...value };
	if (
		typeof merged.enabled !== "boolean" ||
		!count(merged.minSourceTokens, 1, 1_000_000) ||
		!count(merged.minIntervalMs, 0, 3_600_000) ||
		!count(merged.deadlineMs, 1, 600_000) ||
		!count(merged.maxCallsPerAttempt, 1, 256) ||
		!isRecord(merged.ledger)
	)
		return disabled();
	const base = DEFAULT_PREPARATION_CONFIG.ledger;
	if (Object.keys(merged.ledger).some((key) => !Object.keys(base).includes(key))) return disabled();
	const ledger = { ...base, ...merged.ledger };
	if (
		!Object.values(ledger).every((field) => count(field, 1, Number.MAX_SAFE_INTEGER / 1024)) ||
		ledger.maxCallsPerSession > 256 ||
		ledger.maxCallsPerInterval > ledger.maxCallsPerSession ||
		ledger.maxAttemptsPerInterval > ledger.maxCallsPerInterval ||
		ledger.maxReservedTokensPerInterval > ledger.maxReservedTokensPerSession ||
		ledger.maxReservedCostMicrosPerInterval > ledger.maxReservedCostMicrosPerSession ||
		ledger.maxDetails > 256 ||
		merged.maxCallsPerAttempt > ledger.maxCallsPerInterval
	)
		return disabled();
	return {
		config: Object.freeze({
			enabled: merged.enabled,
			minSourceTokens: merged.minSourceTokens,
			minIntervalMs: merged.minIntervalMs,
			deadlineMs: merged.deadlineMs,
			maxCallsPerAttempt: merged.maxCallsPerAttempt,
			ledger: Object.freeze(ledger),
		}),
	};
}

/** Latched with the ordinary configuration; invalid optional settings pause preparation only. */
export function readPreparationConfig(agentDir: string): PreparationConfigResult {
	const path = join(agentDir, "pi-context-memory.json");
	const prior = cached.get(path);
	if (prior) return prior;
	let result: PreparationConfigResult;
	try {
		const value: unknown = JSON.parse(readBoundedFile(path, 64 * 1024, "preparation-config").toString("utf8"));
		result = isRecord(value)
			? parsePreparationConfig(value.previewPreparation)
			: { config: DEFAULT_PREPARATION_CONFIG, error: "invalid-config" };
	} catch (error) {
		result = missing(error)
			? { config: DEFAULT_PREPARATION_CONFIG }
			: { config: DEFAULT_PREPARATION_CONFIG, error: "invalid-config" };
	}
	cached.set(path, result);
	return result;
}
