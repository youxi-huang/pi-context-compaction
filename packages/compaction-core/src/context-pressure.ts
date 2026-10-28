/** Verified route limits supplied by the caller; missing metadata is never guessed. */
export interface ContextLimits {
	contextWindow: number;
	/** Effective output reservation for this route, including reasoning where applicable. */
	maxOutputTokens: number;
	/** A separate provider input ceiling, when declared. It is not the combined context window. */
	inputLimit?: number;
}

/** A preparation band, not a scheduler or permission to submit an oversized request. */
export function preparationStartTokens(threshold: number): number {
	if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error("CONTEXT_CAPACITY: invalid threshold");
	return Math.max(0, threshold - Math.min(32_768, Math.max(8_192, Math.floor(threshold * 0.125))));
}

/**
 * Conservative, opt-in starting parameters for host-native compaction. No special case for 200k,
 * no model calls, and no change to the checkpoint budget or a host's request-admission contract.
 */
export function contextPressurePlan(limits: ContextLimits) {
	const { contextWindow, maxOutputTokens, inputLimit } = limits;
	if (
		!Number.isSafeInteger(contextWindow) ||
		contextWindow < 4096 ||
		!Number.isSafeInteger(maxOutputTokens) ||
		maxOutputTokens < 1 ||
		maxOutputTokens >= contextWindow ||
		(inputLimit !== undefined && (!Number.isSafeInteger(inputLimit) || inputLimit < 1 || inputLimit > contextWindow))
	) {
		throw new Error("CONTEXT_CAPACITY: provide verified context/output limits and a consistent optional input limit");
	}
	const inputCeiling = Math.min(contextWindow - maxOutputTokens, inputLimit ?? contextWindow);
	const headroomTokens = 8192;
	const triggerTokens = Math.floor(Math.min(contextWindow * 0.75, inputCeiling - headroomTokens));
	if (triggerTokens < 4096) throw new Error("CONTEXT_CAPACITY: output and headroom leave too little usable input");
	return {
		inputCeiling,
		headroomTokens,
		triggerTokens,
		prepareTokens: preparationStartTokens(triggerTokens),
		keepRecentTokens: Math.min(15_000, Math.floor(triggerTokens * 0.1)),
	};
}
