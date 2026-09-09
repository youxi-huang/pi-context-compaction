import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { isRecord } from "./identity.ts";

/**
 * Local, append-only evaluation log. One JSON object per line in `context-memory-events.jsonl`
 * under the agent directory. It records counts, sizes, durations and error codes only: no message
 * text, note content, quotes, queries, file paths or free-form error messages ever enter this file.
 * Logging failures are remembered for `/compaction-status` and never interrupt the session.
 */

export type CompactionOutcome = "committed" | "failed" | "aborted";
export type CompactionReason = "manual" | "threshold" | "overflow";

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost: number;
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
	tokensBefore?: number;
	/** Estimated tokens of note, system prompt and kept messages after compaction. */
	tokensAfter?: number;
	threshold?: number;
	noteTokens?: number;
	noteBudget?: number;
	/** Original message entries the writer had not covered before this compaction. */
	sourceEntries?: number;
	keptMessages?: number;
	increments?: number;
	chunkCount?: number;
	usage?: UsageSummary;
	/** Reasoning effort sent with the writer request, or `off`. */
	writerEffort?: ThinkingLevel | "off";
	/** Estimated tokens of the host-assembled priorCheckpoints section; `noteTokens` measures the note alone. */
	lineageTokens?: number;
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
type WithoutStamp<T> = T extends unknown ? Omit<T, "at" | "build"> : never;
type Recordable = WithoutStamp<Exclude<MemoryEvent, CappedEvent>>;
type CountedKind = Recordable["event"];

export const EVENT_LOG_FILE = "context-memory-events.jsonl";
/** Per-session quotas. A failure loop cannot grow the file without bound. */
export const EVENT_CAPS: Readonly<Record<CountedKind, number>> = Object.freeze({
	compaction: 40,
	guard: 40,
	history: 300,
	note: 60,
});
/** Whenever the file reaches this size it is renamed to `.1`, replacing the previous generation. */
export const EVENT_LOG_ROTATE_BYTES = 8 * 1024 * 1024;
/** Quota reload reads at most this many bytes from the end of each generation. */
export const EVENT_LOG_SCAN_BYTES = 2 * 1024 * 1024;

/** Every error class this extension throws. The log never emits a class outside this set, HTTP_nnn or the errno list. */
export const PROJECT_CODES: ReadonlySet<string> = new Set([
	"CONTEXT_BLOCKED",
	"CONTEXT_BUSY",
	"CONTEXT_CAPACITY",
	"CONTEXT_COMPACTOR_CONFLICT",
	"CONTEXT_CONFIG",
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
	"CONTEXT_NOTE_SCOPE",
	"CONTEXT_NOTE_VERSION",
	"CONTEXT_PAYLOAD_TOO_LARGE",
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

export function summarizeUsage(usage: Usage): UsageSummary {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
		totalTokens: usage.totalTokens,
		cost: usage.cost.total,
	};
}

export class EventLog {
	/** Undefined when logging is disabled or no agent directory exists. */
	readonly file?: string;
	lastError?: string;
	private readonly build: string;
	private prepared = false;
	private readonly counts = new Map<string, Record<CountedKind, number>>();

	constructor(agentDir: string | undefined, enabled: boolean, build: string) {
		this.build = build;
		this.file = enabled && agentDir ? join(resolve(agentDir), EVENT_LOG_FILE) : undefined;
	}

	record(event: Recordable): void {
		if (!this.file) return;
		try {
			this.prepare();
			const counts = this.sessionCounts(event.session);
			const limit = EVENT_CAPS[event.event];
			this.lastError = undefined;
			if (counts[event.event] >= limit) return;
			this.write(event);
			counts[event.event]++;
			if (counts[event.event] === limit)
				this.write({ event: "capped", session: event.session, kind: event.event, limit });
		} catch (error) {
			this.lastError = errorCode(error instanceof Error ? error.message : String(error));
		}
	}

	private write(event: Recordable | WithoutStamp<CappedEvent>): void {
		const line = JSON.stringify({ at: new Date().toISOString(), build: this.build, ...event });
		appendFileSync(this.file as string, `${line}\n`, { mode: 0o600 });
	}

	/** Directory, permissions and rotation are settled before any count or write. */
	private prepare(): void {
		const file = this.file as string;
		if (!this.prepared) {
			mkdirSync(dirname(file), { recursive: true });
			if (existsSync(file)) chmodSync(file, 0o600);
			this.prepared = true;
		}
		if (existsSync(file) && statSync(file).size >= EVENT_LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
		// In-memory counts stay valid across rotation: the quota is per session, not per file generation.
	}

	/**
	 * Quotas survive restarts: the first event of a session in this process counts its lines in the tail
	 * window of the live file and the previous generation. Older lines can only under-count, never over-count.
	 */
	private sessionCounts(session: string): Record<CountedKind, number> {
		const cached = this.counts.get(session);
		if (cached) return cached;
		const counts: Record<CountedKind, number> = { compaction: 0, guard: 0, history: 0, note: 0 };
		const file = this.file as string;
		for (const candidate of [`${file}.1`, file]) {
			for (const line of tailLines(candidate, EVENT_LOG_SCAN_BYTES)) {
				if (!line.includes(session)) continue;
				try {
					const parsed: unknown = JSON.parse(line);
					if (
						isRecord(parsed) &&
						parsed.session === session &&
						typeof parsed.event === "string" &&
						parsed.event in counts
					)
						counts[parsed.event as CountedKind]++;
				} catch {
					/* A torn line from an interrupted write is not counted. */
				}
			}
		}
		this.counts.set(session, counts);
		return counts;
	}
}

/** Complete lines from the last `bytes` of a file; a leading partial line is dropped. */
function tailLines(file: string, bytes: number): string[] {
	if (!existsSync(file)) return [];
	const size = statSync(file).size;
	const start = Math.max(0, size - bytes);
	const buffer = Buffer.alloc(size - start);
	const fd = openSync(file, "r");
	try {
		readSync(fd, buffer, 0, buffer.length, start);
	} finally {
		closeSync(fd);
	}
	const lines = buffer.toString("utf8").split("\n");
	if (start > 0) lines.shift();
	return lines;
}
