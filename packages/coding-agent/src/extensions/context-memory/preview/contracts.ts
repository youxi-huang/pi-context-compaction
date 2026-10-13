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
	};
	/** User messages rendered verbatim after the note by the notes path; re-rendered at every full validation. */
	userMessages?: string[];
}
export type PreviewCompaction = CompactionResult<PreviewCheckpoint>;

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
	/** What this preview requires: a completed turn, no queued input and no durable block. */
	preview: "ready" | "waiting-for-turn" | "blocked" | "not-active";
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
