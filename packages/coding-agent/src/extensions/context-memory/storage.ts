import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	ftruncateSync,
	linkSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { FileEntry, SessionEntry } from "../../core/session-manager.ts";
import { CONTEXT_KEEP_NONE, CONTEXT_MEMORY_KIND, hashEntries, isRecord } from "./identity.ts";
import { canonicalSessionPath, SessionLease } from "./lease.ts";

function stamp(file: string): string | undefined {
	if (!existsSync(file)) return undefined;
	const stat = statSync(file, { bigint: true });
	// ctime also changes when macOS attaches metadata; it does not establish a content write.
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

/** Reject opaque placeholders even in fallback mode. Migration works on an explicit copy. */
export function assertReadableBranch(branch: readonly SessionEntry[]): void {
	const latest = [...branch].reverse().find((entry) => entry.type === "compaction");
	if (latest?.type !== "compaction") return;
	const details = latest.details;
	if (
		(isRecord(details) && details.kind === "pi-codex-remote-compaction") ||
		/PI_CODEX_REMOTE_CHECKPOINT:|stores the older history opaquely|Full replay requires @narumitw\/pi-codex-compact/.test(
			latest.summary,
		)
	) {
		throw new Error(
			"CONTEXT_MIGRATION_REQUIRED: this branch contains an opaque checkpoint; migrate a verified copy before resuming",
		);
	}
}

export function assertCandidate(entry: SessionEntry, sessionId: string, branch: readonly SessionEntry[]): void {
	assertReadableBranch(branch);
	if (entry.type !== "compaction" || !isRecord(entry.details) || entry.details.kind !== CONTEXT_MEMORY_KIND) return;
	const snapshot = entry.details.snapshot;
	if (
		!isRecord(snapshot) ||
		snapshot.sessionId !== sessionId ||
		snapshot.leafId !== entry.parentId ||
		snapshot.lastCheckpointId !== ([...branch].reverse().find((item) => item.type === "compaction")?.id ?? null) ||
		!(entry.firstKeptEntryId === CONTEXT_KEEP_NONE || branch.some((item) => item.id === entry.firstKeptEntryId)) ||
		entry.details.sourceHash !== hashEntries(branch)
	) {
		throw new Error("CONTEXT_SOURCE_CHANGED: checkpoint no longer matches its source branch");
	}
}

/** Disk mechanics only. The owner publishes its in-memory tree after these calls succeed. */
export class SessionStorage {
	private lease?: SessionLease;
	private expected?: string;
	private poisoned = false;
	private closed = false;
	private readonly runtimeId = randomUUID();

	assert(): void {
		if (this.closed) throw new Error("CONTEXT_STORAGE_CLOSED: reopen the session before writing");
		if (this.poisoned)
			throw new Error("CONTEXT_STORAGE_UNCERTAIN: rollback failed; inspect the file before reopening");
		this.lease?.assert();
		if (this.lease && stamp(this.lease.file) !== this.expected) {
			throw new Error("CONTEXT_EXTERNAL_WRITE: session file changed outside its writer lease");
		}
	}

	/** Keep the previous lease until the destination has been validated and published. */
	withFile<T>(file: string | undefined, operation: () => T): T {
		this.assert();
		if ((file && canonicalSessionPath(file) === this.lease?.file) || (!file && !this.lease)) return operation();
		const previous = this.lease;
		const previousStamp = this.expected;
		const next = file ? SessionLease.acquire(file, this.runtimeId) : undefined;
		this.lease = next;
		this.expected = next ? stamp(next.file) : undefined;
		let result: T;
		try {
			result = operation();
		} catch (error) {
			try {
				next?.release();
			} finally {
				this.lease = previous;
				this.expected = previousStamp;
			}
			throw error;
		}
		// Destination is committed. A lost old lease must not roll it back or remove somebody else's lock.
		try {
			previous?.release();
		} catch {
			/* The old lock stays available for inspection. */
		}
		return result;
	}

	append(entry: SessionEntry): void {
		this.appendText(`${JSON.stringify(entry)}\n`);
	}

	ensureTrailingNewline(): void {
		this.assert();
		if (!this.lease || this.expected === undefined || statSync(this.lease.file).size === 0) return;
		const fd = openSync(this.lease.file, "r");
		const last = Buffer.alloc(1);
		try {
			readSync(fd, last, 0, 1, statSync(this.lease.file).size - 1);
		} finally {
			closeSync(fd);
		}
		if (last[0] !== 10) this.appendText("\n");
	}

	private appendText(text: string): void {
		this.assert();
		if (!this.lease) return;
		const file = this.lease.file;
		const length = statSync(file).size;
		const fd = openSync(file, "a");
		try {
			writeFileSync(fd, text);
			fsyncSync(fd);
		} catch (error) {
			try {
				ftruncateSync(fd, length);
				fsyncSync(fd);
			} catch {
				this.poisoned = true;
				this.lease.requireRecovery(`append rollback failed at byte ${length}`);
			}
			throw error;
		} finally {
			closeSync(fd);
			this.expected = stamp(file);
		}
	}

	/** Atomic full write for first flush, migration and fork. Existing files survive write errors. */
	replace(entries: readonly FileEntry[]): void {
		this.assert();
		if (!this.lease) return;
		const file = this.lease.file;
		const temporary = join(dirname(file), `.context-write-${randomUUID()}`);
		const fd = openSync(temporary, "wx", 0o600);
		try {
			for (const entry of entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			fsyncSync(fd);
		} catch (error) {
			unlinkSync(temporary);
			throw error;
		} finally {
			closeSync(fd);
		}
		try {
			this.assert();
			if (this.expected === undefined) {
				linkSync(temporary, file); // Exclusive destination publication; never overwrite a raced file.
			} else {
				renameSync(temporary, file);
			}
		} finally {
			try {
				if (existsSync(temporary)) unlinkSync(temporary);
			} catch {
				/* Publication has already succeeded. */
			}
		}
		this.expected = stamp(file);
	}

	close(): void {
		if (this.closed) return;
		this.lease?.release();
		this.closed = true;
	}
}
