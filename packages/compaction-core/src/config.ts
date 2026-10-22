// Retyped copy of the resident config.ts's budget half (v0.7.0 plan, WP1): the note budgets
// (`selectNoteBudget`, `storedNoteLimit` and their types), `textTokens` and `memoryBudget`, with the
// host's model type replaced by the structural shape the budget actually reads. Logic, bounds and
// thrown messages are unchanged (rule K2). `readMemoryConfig`'s settings-file reading and the host
// model typing stay host-side. The resident copy keeps its bytes (rule K9).
import { isRecord } from "./identity.ts";

/** The model fields the budget reads; a host's native model satisfies this shape. */
export interface BudgetModel {
	id: string;
	contextWindow: number;
	maxTokens: number;
}

/** The validated configuration fields the budgets read; a host's native configuration satisfies this shape. */
export interface MemoryBudgetConfig {
	/** Original tokens kept after a compaction. 0 keeps nothing once the current turn is complete. */
	keepRecentTokens: number;
	/** An explicit fixed upper bound. Omission selects per-compaction tiered budgets. */
	noteTokens?: number;
	/** Automatic compaction point: a token count above 1, or a share of the context window at or below 1. */
	compactAt?: number;
}

const DEFAULT_BUDGET_CONFIG: Readonly<MemoryBudgetConfig> = Object.freeze({ keepRecentTokens: 0 });

function isCount(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

export interface MemoryBudget {
	capacity: number;
	reserve: number;
	/** Automatic compaction point; lowering it must not shrink the model's usable input window. */
	threshold: number;
	/** Final input safety limit, independent of the preferred compaction point. */
	inputLimit: number;
	noteTokens: number;
	recentTokens: number;
}

export function memoryBudget(model: BudgetModel, config: MemoryBudgetConfig = DEFAULT_BUDGET_CONFIG): MemoryBudget {
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
		inputLimit: capacity - reserve,
		// Stable pending-candidate allowance; the writer budget is selected after the cut, not here.
		noteTokens: Math.max(500, Math.min(config.noteTokens ?? 3000, MAX_NOTE_TOKENS, Math.floor(threshold * 0.15))),
		recentTokens: Math.min(config.keepRecentTokens, Math.floor(threshold * 0.5)),
	};
}

/** Storage safety bound, independent of the model or configuration used to reopen a checkpoint. */
export const MAX_NOTE_TOKENS = 8000;

export interface NoteBudget {
	version: 1;
	mode: "fixed" | "tiered";
	/** Source-size tier, before the previous-note floor and capacity caps. 0 denotes fixed mode. */
	tier: number;
	sourceTokens: number;
	previousTokens: number;
	baseTokens: number;
	hardTokens: number;
}

/** Freeze this decision before invoking the writer. Never enlarge it in response to a candidate. */
export function selectNoteBudget(
	config: Pick<MemoryBudgetConfig, "noteTokens">,
	threshold: number,
	sourceTokens: number,
	previousTokens = 0,
): NoteBudget {
	if (![sourceTokens, previousTokens].every((value) => Number.isSafeInteger(value) && value >= 0))
		throw new Error("CONTEXT_CONFIG: invalid note budget measurement");
	const cap = Math.max(500, Math.min(MAX_NOTE_TOKENS, Math.floor(threshold * 0.15)));
	const fixed = config.noteTokens !== undefined;
	const tier = sourceTokens <= 80_000 ? 1 : sourceTokens <= 200_000 ? 2 : sourceTokens <= 400_000 ? 3 : 4;
	const base = fixed
		? config.noteTokens!
		: Math.max([3000, 4000, 5000, 6000][tier - 1], Math.ceil(previousTokens * 0.9));
	const hard = fixed ? config.noteTokens! : Math.max([4000, 5000, 6000, 8000][tier - 1], previousTokens);
	return {
		version: 1,
		mode: fixed ? "fixed" : "tiered",
		tier: fixed ? 0 : tier,
		sourceTokens,
		previousTokens,
		baseTokens: Math.min(base, cap),
		hardTokens: Math.min(hard, cap),
	};
}

/** Validate stored policy metadata, not today's generation preferences. Old checkpoints omit it. */
export function storedNoteLimit(value: unknown): number {
	if (value === undefined) return 6000;
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!(value.mode === "fixed" || value.mode === "tiered") ||
		!isCount(value.tier, 0) ||
		value.tier > 4 ||
		(value.mode === "fixed" ? value.tier !== 0 : value.tier === 0) ||
		!isCount(value.sourceTokens, 0) ||
		!Number.isSafeInteger(value.sourceTokens) ||
		!isCount(value.previousTokens, 0) ||
		!Number.isSafeInteger(value.previousTokens) ||
		!isCount(value.baseTokens, 500) ||
		!isCount(value.hardTokens, 500) ||
		value.baseTokens > value.hardTokens ||
		value.hardTokens > MAX_NOTE_TOKENS ||
		(value.mode === "fixed" && value.baseTokens !== value.hardTokens)
	)
		throw new Error("CONTEXT_NOTE_VERSION: invalid stored note budget");
	return value.hardTokens;
}

/** Conservative text estimate. Provider usage remains the authoritative billing measure. */
export function textTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}
