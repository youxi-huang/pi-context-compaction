import type { CompactionEntry, CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryCheckpoint } from "../notes.ts";

export type PreviewSession = ExtensionContext["sessionManager"];
export type PreviewCompaction = CompactionResult<MemoryCheckpoint>;

export interface PreviewAttempt {
	attemptId: string;
	sessionId: string;
	leafId: string;
	lastCheckpointId: string | null;
	sourceHash: string;
}

export interface PreviewStatus {
	state: "ready" | "pending" | "blocked";
	code?: string;
}

/** Operational markers contain hashes and identifiers, never transcript or note text. */
export interface PreviewFailureStoreContract {
	assertReady(session: PreviewSession): void;
	status(session: PreviewSession): PreviewStatus;
	/** Only an explicit manual compaction may replace a previous failure marker. */
	begin(session: PreviewSession, explicitRetry?: boolean): PreviewAttempt;
	stage(session: PreviewSession, attempt: PreviewAttempt, candidate: PreviewCompaction): void;
	/** Success requires reading the matching checkpoint and original sources from disk. */
	commit(session: PreviewSession, entry: CompactionEntry): void;
	/** Explicitly confirms an already staged durable checkpoint whose commit was not observed. */
	recover(session: PreviewSession, entry: CompactionEntry): void;
	fail(session: PreviewSession, code: string): void;
}
