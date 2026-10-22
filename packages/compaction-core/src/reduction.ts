import { CONTEXT_MEMORY_KIND, CONTEXT_NOTE_TYPE, isRecord } from "./identity.ts";

/**
 * Deterministic reversible context reductions (v0.6.0 WP2).
 *
 * Lifted unchanged from the preview into the host-neutral core (v0.7.0 WP2 step 1); only the
 * identity import moved to the core's byte-identical copy.
 *
 * `reduceRecords` is a pure function of the branch's records and the model's declared prompt-cache
 * lifetime: the same records always produce the same bytes, across requests, reopens and process
 * restarts, and nothing here reads host state, the wall clock or anything outside its arguments
 * (G1, G10). It is written against the minimal structural record shapes below so that 0.7.0 can
 * lift it into a host-neutral core unchanged. Nothing in the session file is rewritten (G3): a
 * reduction exists only in the view the caller projects, `context_history` reads the original
 * record back in full, and deleting this module restores the full view.
 *
 * Candidates, both tool results and both without any model call:
 * - R-A, the superseded file read: an earlier result of the same tool for the same recognized
 *   target (one of {@link TARGET_KEYS}) with a later non-error result present; the latest result
 *   stays full.
 * - R-B, the consumed tool result: a result whose turn completed and after which at least one
 *   later assistant turn finished.
 *
 * Implementation decisions the plan left open, recorded here:
 * - A "completed turn" is an assistant record with `stopReason === "stop"`, the same boundary
 *   `inProgressRequests` uses. R-B's "later assistant turn finished" is therefore the second
 *   assistant stop after the result: the first completes the result's own turn, the second proves
 *   a later turn consumed it.
 * - The reducible tool set for R-B is every tool result except `context_note` confirmations
 *   (the note record itself is protected by G6, and its confirmation is the pairing evidence),
 *   error results, and results whose content is not entirely text. User messages, assistant text,
 *   checkpoint summaries and `context_note` records are never candidates (G6); only a tool
 *   result's text is ever replaced, and its call stays verbatim (G5).
 *
 * Eligibility is evaluated at record prefixes: an entry becomes reduced at the earliest prefix of
 * the records at which every clause holds, and stays reduced for every longer prefix, so appending
 * records never un-reduces an entry and the reduced prefix is byte-stable and monotone (G2).
 */

/** The message fields the reduction reads; every Pi session message satisfies this shape. */
export interface ReductionRecordMessage {
	readonly role: string;
	readonly stopReason?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
	readonly content?: unknown;
}

/** The record fields the reduction reads; every Pi session entry satisfies this shape. */
export interface ReductionRecord {
	readonly id: string;
	readonly type: string;
	/** The record's stored timestamp; the idle trigger reads gaps between these, never the clock. */
	readonly timestamp: string;
	readonly message?: ReductionRecordMessage;
	readonly customType?: string;
	readonly summary?: string;
	readonly details?: unknown;
	readonly data?: unknown;
}

/** The projected-message fields the applier reads; Pi's `AgentMessage` satisfies this shape. */
export interface ReducibleMessage {
	readonly role: string;
	readonly toolCallId?: string;
	readonly content?: unknown;
}

export interface ReducedEntry {
	/** Session record ID of the reduced tool result; `context_history` reads it back in full. */
	readonly recordId: string;
	/** The paired call's ID; the view replaces the matching projected tool result's text. */
	readonly toolCallId: string;
	/** The one byte-stable replacement line. */
	readonly line: string;
	/** Estimated tokens the replacement removes, on Pi's four-characters-per-token scale. */
	readonly tokensRemoved: number;
}

/** The reduced view of one branch: recomputed on every call, never stored. */
export interface ReductionView {
	readonly entries: readonly ReducedEntry[];
	/** Sum of `tokensRemoved`, for content-free status counts. */
	readonly tokensRemoved: number;
}

/**
 * M5 suffix bound: an entry first reduces only when the estimated tokens that follow it on the
 * branch are no more than this multiple of the tokens the reduction removes, so one reduction
 * never writes more cache than it saves on its own request.
 */
export const REDUCTION_SUFFIX_RATIO = 1;
/** M5 idle bound where a model declares no prompt-cache lifetime: one hour is assumed. */
export const DEFAULT_CACHE_LIFETIME_MS = 3_600_000;
/** Bound on the stub's quoted first result line, so the replacement itself stays one short line. */
const REDUCTION_HEAD_CHARS = 120;

/** Call-argument keys recognized as a tool's primary target, in precedence order. */
const TARGET_KEYS = ["path", "file_path", "filePath", "file", "entryId", "url", "uri"] as const;

/** Results of these tools are never reduced; the saved note record itself is already G6-protected. */
const EXCLUDED_TOOLS: ReadonlySet<string> = new Set(["context_note"]);

/** Deterministic token estimate on Pi's four-characters-per-token scale. */
function reductionTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function textBlocks(content: unknown): string[] | undefined {
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
		texts.push(block.text);
	}
	return texts;
}

/** The record's visible text, for the deterministic suffix estimate. */
function recordText(record: ReductionRecord): string {
	if (record.type === "message" && record.message) {
		const content = record.message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map((block) =>
					isRecord(block) && typeof block.text === "string" ? block.text : (JSON.stringify(block) ?? ""),
				)
				.join("\n");
		}
		return "";
	}
	if (typeof record.summary === "string") return record.summary;
	return "";
}

/** The primary target of a tool call, read from its arguments; empty when none is recognized. */
function callTarget(args: unknown): string {
	if (!isRecord(args)) return "";
	for (const key of TARGET_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.length) return value;
	}
	return "";
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The one byte-stable line that replaces an eligible result's text in the view. */
export function reductionLine(tool: string, target: string, head: string, recordId: string): string {
	const shownTarget = oneLine(target).slice(0, REDUCTION_HEAD_CHARS) || "(no target)";
	const shownHead = oneLine(head).slice(0, REDUCTION_HEAD_CHARS);
	return `[reduced tool result] ${tool} ${shownTarget} => ${shownHead} | entry ${recordId}; context_history reads this entry back in full`;
}

/**
 * The longest prompt-cache lifetime the model declares, in milliseconds; undefined when it
 * declares none. Taking the longest declared tier keeps the idle trigger conservative.
 */
export function declaredCacheLifetimeMs(model?: {
	promptCache?: { short?: number; long?: number };
}): number | undefined {
	const declared = [model?.promptCache?.short, model?.promptCache?.long].filter(
		(value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
	);
	return declared.length ? Math.max(...declared) * 1000 : undefined;
}

/** Entry IDs that are the only cited source of some fact, mapped to the first record index that cites them. */
function soleEvidenceFrom(records: readonly ReductionRecord[]): Map<string, number> {
	const protectedFrom = new Map<string, number>();
	const scanFacts = (value: unknown, index: number): void => {
		if (!isRecord(value)) return;
		for (const section of Object.values(value)) {
			if (!Array.isArray(section)) continue;
			for (const item of section) {
				if (!isRecord(item) || !Array.isArray(item.sources)) continue;
				if (item.sources.length === 1 && typeof item.sources[0] === "string" && !protectedFrom.has(item.sources[0]))
					protectedFrom.set(item.sources[0], index);
			}
		}
	};
	for (const [index, record] of records.entries()) {
		if (record.type === "compaction" && isRecord(record.details) && record.details.kind === CONTEXT_MEMORY_KIND)
			scanFacts(record.details.note, index);
		if (record.type === "custom" && record.customType === CONTEXT_NOTE_TYPE) scanFacts(record.data, index);
	}
	return protectedFrom;
}

/**
 * The reduced view of the branch: which tool results the projection replaces, and by what line.
 * Pure and deterministic; see the module comment for the eligibility contract.
 */
export function reduceRecords(records: readonly ReductionRecord[], cacheLifetimeMs: number | undefined): ReductionView {
	const lifetimeMs = cacheLifetimeMs ?? DEFAULT_CACHE_LIFETIME_MS;
	// Prefix token sums of each record's visible text, so suffix estimates read only the records.
	const prefixTokens: number[] = [0];
	for (const record of records)
		prefixTokens.push(prefixTokens[prefixTokens.length - 1] + reductionTokens(recordText(record)));
	// Completed assistant turns, the boundary inProgressRequests uses.
	const stops: number[] = [];
	// Paired tool calls, by call ID, with the tool's name and recognized target.
	const calls = new Map<string, { name: string; target: string }>();
	// Non-error, all-text tool results per tool-and-target key, in branch order, for R-A supersession.
	const resultsByTarget = new Map<string, number[]>();
	for (const [index, record] of records.entries()) {
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		if (message.role === "assistant") {
			if (message.stopReason === "stop") stops.push(index);
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (
						isRecord(block) &&
						block.type === "toolCall" &&
						typeof block.id === "string" &&
						typeof block.name === "string"
					)
						calls.set(block.id, { name: block.name, target: callTarget(block.arguments) });
				}
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string" && message.isError !== true) {
			const call = calls.get(message.toolCallId);
			if (call?.target && textBlocks(message.content) !== undefined) {
				const key = `${call.name}\n${call.target}`;
				resultsByTarget.set(key, [...(resultsByTarget.get(key) ?? []), index]);
			}
		}
	}
	const protectedFrom = soleEvidenceFrom(records);
	const entries: ReducedEntry[] = [];
	let tokensRemoved = 0;
	for (const [index, record] of records.entries()) {
		if (record.type !== "message" || record.message?.role !== "toolResult") continue;
		const message = record.message;
		// Pairing complete, the reducible set, and never an error result.
		if (typeof message.toolCallId !== "string" || message.isError === true) continue;
		const call = calls.get(message.toolCallId);
		if (!call || EXCLUDED_TOOLS.has(call.name)) continue;
		const texts = textBlocks(message.content);
		if (texts === undefined) continue;
		const resultText = texts.join("\n");
		if (!resultText) continue;
		// Active requests kept: the result's own turn must have completed.
		const stopAt = stops.findIndex((stop) => stop > index);
		if (stopAt < 0) continue;
		// R-B: a later assistant turn finished after the completing stop.
		const consumedAt = stopAt + 1 < stops.length ? stops[stopAt + 1] : undefined;
		// R-A: a later non-error result of the same tool and target; the latest read stays full.
		const siblings = call.target ? (resultsByTarget.get(`${call.name}\n${call.target}`) ?? []) : [];
		const laterRead = siblings.find((at) => at > index);
		const supersededAt = laterRead !== undefined ? Math.max(laterRead, stops[stopAt]) : undefined;
		const eligibleAt = [consumedAt, supersededAt]
			.filter((at): at is number => at !== undefined)
			.reduce<number | undefined>(
				(earliest, at) => (earliest === undefined ? at : Math.min(earliest, at)),
				undefined,
			);
		if (eligibleAt === undefined) continue;
		// Sole evidence kept: a fact citing this entry alone, before it could reduce, keeps it full.
		const citedFrom = protectedFrom.get(record.id);
		if (citedFrom !== undefined && citedFrom <= eligibleAt) continue;
		const line = reductionLine(call.name, call.target, resultText.split(/\r?\n/, 1)[0], record.id);
		const removed = reductionTokens(resultText) - reductionTokens(line);
		if (removed <= 0) continue;
		// Timing (M5): both tests read only the records, so once reduced, always reduced.
		const suffixTokens = prefixTokens[eligibleAt + 1] - prefixTokens[index + 1];
		const next = records[index + 1];
		const gapMs = next ? Date.parse(next.timestamp) - Date.parse(record.timestamp) : Number.NaN;
		const idle = Number.isFinite(gapMs) && gapMs > lifetimeMs;
		if (suffixTokens > removed * REDUCTION_SUFFIX_RATIO && !idle) continue;
		entries.push({ recordId: record.id, toolCallId: message.toolCallId, line, tokensRemoved: removed });
		tokensRemoved += removed;
	}
	return { entries, tokensRemoved };
}

/**
 * Apply one reduced view to a projected message list: each reduced tool result's content becomes
 * its one line; every other message, and every tool call, passes through untouched (G5). The same
 * application serves the `context` projection and the writer's session prefix (G4).
 */
export function applyReduction<T extends ReducibleMessage>(messages: readonly T[], view: ReductionView): T[] {
	if (!view.entries.length) return [...messages];
	const lines = new Map(view.entries.map((entry) => [entry.toolCallId, entry.line]));
	return messages.map((message) => {
		const line =
			message.role === "toolResult" && typeof message.toolCallId === "string"
				? lines.get(message.toolCallId)
				: undefined;
		if (line === undefined) return message;
		// The replacement block is a valid tool-result content block for every caller of this module.
		return { ...message, content: [{ type: "text", text: line }] } as T;
	});
}
