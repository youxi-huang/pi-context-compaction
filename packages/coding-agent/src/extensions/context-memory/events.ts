import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
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
/** The file rotates once to `.1` past this size; older rotations are discarded. */
export const EVENT_LOG_ROTATE_BYTES = 8 * 1024 * 1024;

/** Reduce any error to a bounded class name. Free text never reaches the log. */
export function errorCode(message: string | undefined, aborted = false): string {
	// Bounded input and bounded quantifiers only: provider error text is untrusted.
	const text = (message ?? "").slice(0, 2000);
	const project = text.match(/\b(?:CONTEXT|HISTORY)_[A-Z_]+/);
	if (project) return project[0];
	if (aborted || /\babort|\bcancel/i.test(text)) return "ABORTED";
	const status = text.match(/\b(?:status(?: code)?|http)[\s:]{0,4}([45]\d\d)\b/i);
	if (status) return `HTTP_${status[1]}`;
	const errno = text.match(/\bE[A-Z]{4,}\b/);
	if (errno) return errno[0];
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
	private readonly counts = new Map<string, Record<CountedKind, number>>();

	constructor(agentDir: string | undefined, enabled: boolean, build: string) {
		this.build = build;
		this.file = enabled && agentDir ? join(resolve(agentDir), EVENT_LOG_FILE) : undefined;
	}

	record(event: Recordable): void {
		if (!this.file) return;
		try {
			const counts = this.sessionCounts(event.session);
			const limit = EVENT_CAPS[event.event];
			if (counts[event.event] >= limit) return;
			counts[event.event]++;
			this.rotate();
			this.write(event);
			if (counts[event.event] === limit)
				this.write({ event: "capped", session: event.session, kind: event.event, limit });
			this.lastError = undefined;
		} catch (error) {
			this.lastError = errorCode(error instanceof Error ? error.message : String(error));
		}
	}

	private write(event: Recordable | WithoutStamp<CappedEvent>): void {
		const line = JSON.stringify({ at: new Date().toISOString(), build: this.build, ...event });
		appendFileSync(this.file as string, `${line}\n`, { mode: 0o600 });
	}

	private rotate(): void {
		const file = this.file as string;
		if (!existsSync(file) || statSync(file).size < EVENT_LOG_ROTATE_BYTES) return;
		renameSync(file, `${file}.1`);
		this.counts.clear();
	}

	/** Quotas survive restarts: the first event of a session in this process counts its existing lines. */
	private sessionCounts(session: string): Record<CountedKind, number> {
		const cached = this.counts.get(session);
		if (cached) return cached;
		const counts: Record<CountedKind, number> = { compaction: 0, guard: 0, history: 0, note: 0 };
		const file = this.file as string;
		if (existsSync(file)) {
			for (const line of readFileSync(file, "utf8").split("\n")) {
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
