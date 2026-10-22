// Retyped copy of the resident events.ts's contract half (v0.7.0 plan, WP1): the event and usage
// record types, `PROJECT_CODES` and `errorCode`, with the host's thinking-level type replaced by a
// structural mirror. Logic, the closed set and its reduction are unchanged (rule K2). The `EventLog`
// file IO, its quotas, rotation constants and the host usage mapping (`summarizeUsage`) stay
// host-side; the event log is resident-only. The resident copy keeps its bytes (rule K9).
import type { NoteBudget } from "./config.ts";

export type CompactionOutcome = "committed" | "failed" | "aborted";
export type CompactionReason = "manual" | "threshold" | "overflow";

/** Structural mirror of the host's reasoning-effort levels; a host's native level satisfies it. */
export type WriterEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost: number;
}

/** Per-call accounting, including failed calls. Missing usage means unknown cost. No content. */
export interface WriterCallRecord {
	phase: "generate" | "repair";
	ms?: number;
	usage?: UsageSummary;
	noteBytes?: number;
}

interface EventBase {
	at: string;
	session: string;
	build: string;
}

export interface CompactionEvent extends EventBase {
	event: "compaction";
	reason: CompactionReason;
	willRetry: boolean;
	outcome: CompactionOutcome;
	errorCode?: string;
	/** Main model id at the time of compaction; the writer is `writerModel`. */
	model?: string;
	writerModel: string;
	/** Wall-clock from the resident's compaction handler start to commit or failure. */
	compactMs?: number;
	/** Wall-clock spent inside the writer calls. */
	writerMs?: number;
	/** Calls started, including calls that threw or returned an invalid note. Absent in older logs. */
	writerCalls?: number;
	/** Calls that returned usage. The remainder have unknown cost, not zero cost. */
	usageReports?: number;
	tokensBefore?: number;
	/** Estimated tokens of note, system prompt and kept messages after compaction. */
	tokensAfter?: number;
	threshold?: number;
	noteTokens?: number;
	noteBudget?: number;
	/** Frozen tier/fixed policy; noteBudget remains the hard limit for older report consumers. */
	budgetPolicy?: NoteBudget;
	/** Serialized JSON measurement, unlike the rendered noteTokens field. */
	noteJsonBytes?: number;
	elasticUsed?: boolean;
	repairUsed?: boolean;
	writerCallDetails?: WriterCallRecord[];
	/** Original message entries the writer had not covered before this compaction. */
	sourceEntries?: number;
	keptMessages?: number;
	increments?: number;
	chunkCount?: number;
	usage?: UsageSummary;
	/** Reasoning effort sent with the writer request, or `off`. */
	writerEffort?: WriterEffort | "off";
	/** Estimated tokens of the host-assembled priorCheckpoints section; `noteTokens` measures the note alone. */
	lineageTokens?: number;
	/** Host-pinned original user requests for an in-task handover, separate from writer note and lineage. */
	continuationTokens?: number;
	checkpointId?: string;
}

/** A request-side protection fired. Codes are the `CONTEXT_*` prefixes of the thrown errors. */
export interface GuardEvent extends EventBase {
	event: "guard";
	code: string;
}

export interface HistoryEvent extends EventBase {
	event: "history";
	operation: "search" | "read";
	granted: boolean;
	entries?: number;
	cursor?: boolean;
	errorCode?: string;
}

export interface NoteEvent extends EventBase {
	event: "note";
	accepted: boolean;
	errorCode?: string;
}

/** Written once when a session reaches its quota for one event kind; later events of that kind are dropped. */
export interface CappedEvent extends EventBase {
	event: "capped";
	kind: Exclude<MemoryEvent["event"], "capped">;
	limit: number;
}

export type MemoryEvent = CompactionEvent | GuardEvent | HistoryEvent | NoteEvent | CappedEvent;

/** Every error class this extension throws. The log never emits a class outside this set, HTTP_nnn or the errno list. */
export const PROJECT_CODES: ReadonlySet<string> = new Set([
	"CONTEXT_BLOCKED",
	"CONTEXT_BUSY",
	"CONTEXT_CAPACITY",
	"CONTEXT_COMPACTOR_CONFLICT",
	"CONTEXT_CONFIG",
	"CONTEXT_CONTINUATION_MISSING",
	"CONTEXT_EXTERNAL_WRITE",
	"CONTEXT_INPUT_TOO_LARGE",
	"CONTEXT_LOCK_CHANGED",
	"CONTEXT_LOCK_CLOSED",
	"CONTEXT_LOCK_IDENTITY",
	"CONTEXT_LOCK_LOST",
	"CONTEXT_LOCK_PLATFORM",
	"CONTEXT_LOCK_UNKNOWN",
	"CONTEXT_LOCKED",
	"CONTEXT_MIGRATION_REQUIRED",
	"CONTEXT_NO_CUT",
	"CONTEXT_NO_MODEL_OR_SOURCE",
	"CONTEXT_NO_NEW_SOURCE",
	"CONTEXT_NOTE_BUDGET",
	"CONTEXT_NOTE_FROZEN",
	"CONTEXT_NOTE_INVALID",
	"CONTEXT_NOTE_QUOTE",
	"CONTEXT_NOTE_REPAIR_LOSS",
	"CONTEXT_NOTE_SCOPE",
	"CONTEXT_NOTE_VERSION",
	"CONTEXT_PAYLOAD_TOO_LARGE",
	"CONTEXT_RECOVERY_MISSING",
	"CONTEXT_RECOVERY_TOO_LARGE",
	"CONTEXT_RESIDENT_NOT_INITIALIZED",
	"CONTEXT_RESIDENT_REQUIRED",
	"CONTEXT_RUNTIME_CONFLICT",
	"CONTEXT_SOURCE_CHANGED",
	"CONTEXT_STORAGE_CLOSED",
	"CONTEXT_STORAGE_UNCERTAIN",
	"CONTEXT_TOOL_BOUNDARY",
	"CONTEXT_TOOL_CONFLICT",
	"CONTEXT_UNSETTLED",
	"CONTEXT_WRITER_CAPACITY",
	"CONTEXT_WRITER_FAILED",
	"CONTEXT_WRITER_UNAVAILABLE",
	"HISTORY_CURSOR_INVALID",
	"HISTORY_ENTRY_REQUIRED",
	"HISTORY_GRANT_EXISTS",
	"HISTORY_GRANT_NOT_PERSISTED",
	"HISTORY_QUERY_INVALID",
	"HISTORY_QUERY_REQUIRED",
	"HISTORY_SCOPE_DENIED",
]);
const ERRNO_CODES: ReadonlySet<string> = new Set([
	"EACCES",
	"EAGAIN",
	"EBUSY",
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EEXIST",
	"EHOSTUNREACH",
	"EMFILE",
	"ENOENT",
	"ENOSPC",
	"ENOTFOUND",
	"EPERM",
	"EPIPE",
	"EROFS",
	"ETIMEDOUT",
]);

/** Reduce any error to a class from a closed set. Free text never reaches the log. */
export function errorCode(message: string | undefined, aborted = false): string {
	// Bounded input and bounded quantifiers only: provider error text is untrusted.
	const text = (message ?? "").slice(0, 2000);
	const project = text.match(/\b(?:CONTEXT|HISTORY)_[A-Z_]{1,40}\b/);
	if (project && PROJECT_CODES.has(project[0])) return project[0];
	if (aborted || /\babort|\bcancel/i.test(text)) return "ABORTED";
	const status = text.match(/\b(?:status(?: code)?|http)[\s:]{0,4}([45]\d\d)\b/i);
	if (status) return `HTTP_${status[1]}`;
	const errno = text.match(/\bE[A-Z]{3,14}\b/);
	if (errno && ERRNO_CODES.has(errno[0])) return errno[0];
	return "UNKNOWN";
}
