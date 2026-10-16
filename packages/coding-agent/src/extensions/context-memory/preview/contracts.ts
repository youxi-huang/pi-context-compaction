import type { CompactionEntry, CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryCheckpoint } from "../notes.ts";

export type PreviewSession = ExtensionContext["sessionManager"];
export interface PreviewCheckpoint extends MemoryCheckpoint {
	/** Preview-only observational metadata; no extension of checkpoint source scope. */
	preparation?: {
		version: 1;
		path: "complete" | "prefix" | "notes" | "sync";
		candidateId?: string;
		callIds?: string[];
		/** Work notes merged by the notes path. */
		noteIds?: string[];
		/** Why arm B left this compaction to the writer. */
		notesFallback?: NotesFallback;
	};
	/** User messages rendered verbatim after the note by the notes path; re-rendered at every full validation. */
	userMessages?: string[];
}
export type PreviewCompaction = CompactionResult<PreviewCheckpoint>;

/**
 * Why arm B did not commit: no work notes since the previous checkpoint, an unfinished turn, custom focus, a merge
 * the note schema or budget rejects, no cut that releases only covered entries, user messages that do not fit in
 * full, or a result that would not compact enough.
 */
export type NotesFallback = "no-notes" | "unfinished-turn" | "custom-focus" | "merge" | "cut" | "user-messages" | "fit";

export interface PreviewAttempt {
	attemptId: string;
	sessionId: string;
	leafId: string;
	lastCheckpointId: string | null;
	sourceHash: string;
}

/** Why the preview stands aside in a session it never enrolled. Controlled values only. */
export type InactiveReason = "host" | "in-memory" | "foreign-checkpoint" | "image" | "non-text" | "context-edit";

export type Protection = "protected" | "eligible" | "not-protected";

/** Pi's own manual-compaction gate is not visible through the public extension API. */
export interface ManualCompaction {
	/**
	 * What this preview requires before /compact can write a checkpoint: `ready` at a completed turn with no
	 * queued input; `retry` when a new /compact replaces a pending or failed attempt; `waiting-for-turn` until
	 * the turn allows either; `blocked` when /compact cannot help here, as with an unsupported session, an
	 * unreadable configuration or an unavailable writer.
	 */
	preview: "ready" | "retry" | "waiting-for-turn" | "blocked" | "not-active";
	/** A checkpoint Pi already saved after staging awaits /compaction-recover, which confirms it without a model call. */
	recover: boolean;
	/** Pi decides from its own settings whether enough older history exists. */
	pi: "unknown";
	contextTokens: number | null;
	piDefaultKeepRecentTokens: number;
}

/** Read-only findings shared by /compaction-status and /compaction-doctor. */
export interface PreviewDiagnosis {
	build: string;
	host: string;
	supportedHost: string;
	supportedHosts: readonly string[];
	protection: Protection;
	reason?: InactiveReason;
	state: "ready" | "pending" | "blocked" | "inactive";
	code?: string;
	writer?: string;
	writerError?: string;
	checkpointId?: string;
	manualCompaction: ManualCompaction;
}

export interface PreviewStatus {
	state: "ready" | "pending" | "blocked";
	code?: string;
}

/** Operational markers contain hashes and identifiers, never transcript or note text. */
export interface PreviewFailureStoreContract {
	/** Request guard: full readback after a trust boundary, then only a file identity and length check. */
	assertReady(session: PreviewSession): void;
	/** Make the next request read the whole session file back. */
	forgetReadback(): void;
	status(session: PreviewSession): PreviewStatus;
	/** Like status, without latching a newly observed failure. */
	inspect(session: PreviewSession): PreviewStatus;
	/** Whether a pending/blocked record, or an unreadable one, exists for this session. Writes nothing. */
	markerPresent(session: PreviewSession): boolean;
	/** Only an explicit manual compaction may replace a previous failure marker. */
	begin(session: PreviewSession, explicitRetry?: boolean): PreviewAttempt;
	stage(session: PreviewSession, attempt: PreviewAttempt, candidate: PreviewCompaction): void;
	/** Success requires reading the matching checkpoint and original sources from disk. */
	commit(session: PreviewSession, entry: CompactionEntry): void;
	/** Explicitly confirms an already staged durable checkpoint whose commit was not observed. */
	recover(session: PreviewSession, entry: CompactionEntry): void;
	fail(session: PreviewSession, code: string): void;
}
