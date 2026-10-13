import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { types } from "node:util";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CONTEXT_KEEP_NONE, CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION, hashEntries, isRecord } from "../identity.ts";
import type {
	PreviewAttempt,
	PreviewBranchSnapshot,
	PreviewCompaction,
	PreviewFailureStoreContract,
	PreviewSession,
	PreviewStatus,
} from "./contracts.ts";
import {
	canonicalSessionFile,
	markerDirectory,
	missing,
	PreviewStoreError,
	readBoundedFile,
	removeMarker,
	storeErrorCode,
	writeMarker,
} from "./failure-io.ts";

const MAX_MARKER_BYTES = 8192;
// A bound on synchronous readback, not a claim to support arbitrary lifetime logs.
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_ENTRIES = 250_000;
const CODES = new Set([
	"CONTEXT_BLOCKED",
	"CONTEXT_BUSY",
	"CONTEXT_CAPACITY",
	"CONTEXT_COMPACTION_CANCELLED",
	"CONTEXT_COMPACTOR_CONFLICT",
	"CONTEXT_CONFIG",
	"CONTEXT_CONTINUATION_MISSING",
	"CONTEXT_INPUT_TOO_LARGE",
	"CONTEXT_MIGRATION_REQUIRED",
	"CONTEXT_NOTE_BUDGET",
	"CONTEXT_NOTE_FROZEN",
	"CONTEXT_NOTE_INVALID",
	"CONTEXT_NOTE_QUOTE",
	"CONTEXT_NOTE_REPAIR_LOSS",
	"CONTEXT_NOTE_SCOPE",
	"CONTEXT_NOTE_VERSION",
	"CONTEXT_NO_CUT",
	"CONTEXT_NO_MODEL_OR_SOURCE",
	"CONTEXT_NO_NEW_SOURCE",
	"CONTEXT_PAYLOAD_TOO_LARGE",
	"CONTEXT_RECOVERY_MISSING",
	"CONTEXT_RECOVERY_TOO_LARGE",
	"CONTEXT_SOURCE_CHANGED",
	"CONTEXT_TOOL_BOUNDARY",
	"CONTEXT_UNSETTLED",
	"CONTEXT_WRITER_CAPACITY",
	"CONTEXT_WRITER_FAILED",
	"CONTEXT_WRITER_UNAVAILABLE",
	"CONTEXT_PREVIEW_UNSUPPORTED",
	"CONTEXT_PREVIEW_PENDING",
	"CONTEXT_PREVIEW_MARKER_INVALID",
	"CONTEXT_PREVIEW_MARKER_IO",
	"CONTEXT_PREVIEW_SESSION_INVALID",
	"CONTEXT_PREVIEW_SESSION_IO",
	"CONTEXT_PREVIEW_COMMIT_UNCONFIRMED",
	"CONTEXT_PREVIEW_COMPACT_REQUIRED",
]);

interface Marker {
	version: 1;
	state: "pending" | "blocked";
	code: string;
	sessionId: string;
	sessionPathHash: string;
	attempt?: PreviewAttempt;
	candidateHash?: string;
}

interface SessionIdentity {
	sessionId: string;
	file: string;
	sessionPathHash: string;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

function hash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function attemptValid(value: unknown): value is PreviewAttempt {
	return (
		isRecord(value) &&
		Object.keys(value).every((key) =>
			["attemptId", "sessionId", "leafId", "lastCheckpointId", "sourceHash"].includes(key),
		) &&
		identifier(value.attemptId) &&
		identifier(value.sessionId) &&
		identifier(value.leafId) &&
		(value.lastCheckpointId === null || identifier(value.lastCheckpointId)) &&
		hash(value.sourceHash)
	);
}

function parseMarker(value: unknown): Marker {
	if (
		!isRecord(value) ||
		!Object.keys(value).every((key) =>
			["version", "state", "code", "sessionId", "sessionPathHash", "attempt", "candidateHash"].includes(key),
		) ||
		value.version !== 1 ||
		(value.state !== "pending" && value.state !== "blocked") ||
		typeof value.code !== "string" ||
		!CODES.has(value.code) ||
		!identifier(value.sessionId) ||
		!hash(value.sessionPathHash) ||
		(value.attempt !== undefined && (!attemptValid(value.attempt) || value.attempt.sessionId !== value.sessionId)) ||
		(value.state === "pending" && value.attempt === undefined) ||
		(value.candidateHash !== undefined && (!hash(value.candidateHash) || value.attempt === undefined))
	)
		throw new PreviewStoreError("CONTEXT_PREVIEW_MARKER_INVALID");
	return value as unknown as Marker;
}

function sameAttempt(left: PreviewAttempt, right: PreviewAttempt): boolean {
	return (
		left.attemptId === right.attemptId &&
		left.sessionId === right.sessionId &&
		left.leafId === right.leafId &&
		left.lastCheckpointId === right.lastCheckpointId &&
		left.sourceHash === right.sourceHash
	);
}

/** Hash only fields persisted by Pi, excluding estimatedTokensAfter and host metadata. */
function candidateHash(candidate: PreviewCompaction | CompactionEntry): string {
	return hashEntries([
		{
			summary: candidate.summary,
			firstKeptEntryId: candidate.firstKeptEntryId,
			tokensBefore: candidate.tokensBefore,
			details: candidate.details,
			usage: candidate.usage,
		},
	]);
}

function arrayIndex(key: string): number | undefined {
	if (key.length > 10) return undefined;
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key ? index : undefined;
}

interface PrototypeTable {
	keys: readonly PropertyKey[];
	descriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>;
}

function prototypeTable(prototype: object): PrototypeTable {
	const keys = Reflect.ownKeys(prototype);
	const descriptors = new Map<PropertyKey, PropertyDescriptor>();
	for (let index = 0; index < keys.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, keys[index]);
		if (descriptor) descriptors.set(keys[index], descriptor);
	}
	return { keys: Object.freeze(keys), descriptors };
}

// The Node intrinsics and this extension's code are trusted at module initialization.
// This is a source-hook eligibility proof, not a sandbox for pre-load/global builtin rewrites.
const objectPrototypeTable = prototypeTable(Object.prototype);
const arrayPrototypeTable = prototypeTable(Array.prototype);

function samePrototypeTable(prototype: object, baseline: PrototypeTable): boolean {
	const keys = Reflect.ownKeys(prototype);
	if (keys.length !== baseline.keys.length) return false;
	// Do not invoke an altered Array iterator or push while deciding whether it is safe.
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		if (key !== baseline.keys[index]) return false;
		const expected = baseline.descriptors.get(key);
		const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
		if (
			!expected ||
			!descriptor ||
			descriptor.enumerable !== expected.enumerable ||
			descriptor.configurable !== expected.configurable
		)
			return false;
		const data = Object.hasOwn(descriptor, "value");
		if (data !== Object.hasOwn(expected, "value")) return false;
		if (data) {
			if (!Object.is(descriptor.value, expected.value) || descriptor.writable !== expected.writable) return false;
		} else if (descriptor.get !== expected.get || descriptor.set !== expected.set) return false;
	}
	return true;
}

/** Reject hooks without invoking them; memoization lives only inside one preflight. */
function plainData(value: unknown, verified: WeakSet<object>): boolean {
	// A changed parent can supply inherited serializer hooks absent on either
	// standard prototype itself. Refuse it before creating any work arrays.
	if (Object.getPrototypeOf(Array.prototype) !== Object.prototype) return false;
	// Validation also reads inherited schema/fact properties after serialization.
	// Refuse any new contribution, including a data container holding nested hooks.
	// The native __proto__ accessor is allowed only with its exact initial descriptor.
	if (
		!samePrototypeTable(Object.prototype, objectPrototypeTable) ||
		!samePrototypeTable(Array.prototype, arrayPrototypeTable)
	)
		return false;
	const pending: unknown[] = [value];
	const seen = new WeakSet<object>();
	const checked: object[] = [];
	while (pending.length) {
		const current = pending.pop();
		if (current === null || current === undefined) continue;
		if (typeof current !== "object") {
			if (!["string", "number", "boolean"].includes(typeof current)) return false;
			continue;
		}
		if (verified.has(current) || seen.has(current)) continue;
		if (types.isProxy(current)) return false;
		const prototype = Object.getPrototypeOf(current);
		if (Array.isArray(current) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
			return false;
		if (
			(prototype !== null && Object.getOwnPropertyDescriptor(Object.prototype, "toJSON")) ||
			(Array.isArray(current) && Object.getOwnPropertyDescriptor(Array.prototype, "toJSON"))
		)
			return false;
		seen.add(current);
		checked.push(current);
		const arrayLength = Array.isArray(current) ? current.length : undefined;
		let arrayIndices = 0;
		for (const key of Reflect.ownKeys(current)) {
			if (typeof key !== "string" || key === "toJSON") return false;
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor || !Object.hasOwn(descriptor, "value")) return false;
			if (arrayLength !== undefined) {
				const index = arrayIndex(key);
				if (index !== undefined && index < arrayLength) arrayIndices++;
			}
			pending.push(descriptor.value);
		}
		// Holes can invoke inherited indexed getters during JSON.stringify. Count
		// only actual data indices, without iterating a potentially enormous length.
		if (arrayLength !== undefined && arrayIndices !== arrayLength) return false;
	}
	for (const object of checked) verified.add(object);
	return true;
}

const ownedSnapshots = new WeakSet<PreviewBranchSnapshot>();

/** Required metadata must survive JSON serialization without normalization or inheritance. */
function canonicalMetadata(entry: SessionEntry): boolean {
	for (const key of ["id", "type", "timestamp", "parentId"] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(entry, key);
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false;
		const value: unknown = descriptor.value;
		if (key === "id" && !identifier(value)) return false;
		if (key === "type" && (typeof value !== "string" || value === "session")) return false;
		if (key === "timestamp" && typeof value !== "string") return false;
		if (key === "parentId" && value !== null && !identifier(value)) return false;
	}
	return true;
}

/**
 * Preflight before the shared validator serializes anything: a later hook must not
 * modify an already captured source. Non-data branches keep the ordinary readback.
 * The collector and its completed snapshot belong to this one synchronous frame.
 */
export function createPreviewBranchSnapshot(branch: readonly SessionEntry[]):
	| {
			snapshot: PreviewBranchSnapshot;
			onSerializedEntry(index: number, serialized: string): void;
	  }
	| undefined {
	if (!plainData(branch, new WeakSet<object>()) || !branch.every(canonicalMetadata)) return undefined;
	const canonicalLines: Buffer[] = [];
	const snapshot = Object.freeze({ branch, canonicalLines });
	let nextIndex = 0;
	let valid = true;
	if (branch.length === 0) {
		Object.freeze(canonicalLines);
		ownedSnapshots.add(snapshot);
	}
	return {
		snapshot,
		onSerializedEntry(index, serialized) {
			if (!valid || index !== nextIndex || index >= branch.length) {
				valid = false;
				ownedSnapshots.delete(snapshot);
				return;
			}
			canonicalLines.push(Buffer.from(serialized, "utf8"));
			nextIndex++;
			if (nextIndex === branch.length) {
				Object.freeze(canonicalLines);
				ownedSnapshots.add(snapshot);
			}
		},
	};
}

function readSession(identity: SessionIdentity): Map<string, SessionEntry>;
function readSession(
	identity: SessionIdentity,
	allowUnflushed: true,
	snapshot?: PreviewBranchSnapshot,
): Map<string, SessionEntry> | undefined;
function readSession(
	identity: SessionIdentity,
	allowUnflushed = false,
	snapshot?: PreviewBranchSnapshot,
): Map<string, SessionEntry> | undefined {
	try {
		const data = readBoundedFile(identity.file, MAX_SESSION_BYTES, "CONTEXT_PREVIEW_SESSION_INVALID");
		if (data.at(-1) !== 10) throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_INVALID");
		// Count all physical records before parsing, preserving the original limit/error order.
		let lines = 0;
		for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, end + 1)) {
			if (++lines > MAX_SESSION_ENTRIES + 1) throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_INVALID");
		}
		const headerEnd = data.indexOf(10);
		const header: unknown = JSON.parse(data.toString("utf8", 0, headerEnd));
		if (!isRecord(header) || header.type !== "session" || header.version !== 3 || header.id !== identity.sessionId)
			throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_INVALID");
		const entries = new Map<string, SessionEntry>();
		let roots = 0;
		let nextAncestor = 0;
		for (let start = headerEnd + 1; start < data.length; ) {
			const end = data.indexOf(10, start);
			const canonical = snapshot?.canonicalLines[nextAncestor];
			// Parent order places selected ancestors in branch order, even with interleaved siblings.
			// Compare exact bytes before decoding; every noncanonical record retains the lossy UTF8 parser.
			const exact = canonical !== undefined && data.compare(canonical, 0, canonical.length, start, end) === 0;
			const entry: unknown = exact ? snapshot?.branch[nextAncestor] : JSON.parse(data.toString("utf8", start, end));
			if (
				!isRecord(entry) ||
				!identifier(entry.id) ||
				typeof entry.type !== "string" ||
				entry.type === "session" ||
				typeof entry.timestamp !== "string" ||
				(entry.parentId !== null && !identifier(entry.parentId)) ||
				entries.has(entry.id) ||
				(entry.parentId !== null && !entries.has(entry.parentId))
			)
				throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_INVALID");
			if (entry.parentId === null && ++roots !== 1) throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_INVALID");
			entries.set(entry.id, entry as unknown as SessionEntry);
			// A selected ancestor with whitespace or alternate escaping still advances the byte cursor.
			if (snapshot && entry.id === snapshot.branch[nextAncestor]?.id) nextAncestor++;
			start = end + 1;
		}
		return entries;
	} catch (error) {
		if (allowUnflushed && missing(error)) return undefined;
		throw new PreviewStoreError(storeErrorCode(error, "CONTEXT_PREVIEW_SESSION_IO"));
	}
}

function branchAt(entries: ReadonlyMap<string, SessionEntry>, leafId: string): SessionEntry[] {
	const branch: SessionEntry[] = [];
	let id: string | null = leafId;
	while (id !== null) {
		const entry = entries.get(id);
		if (!entry) throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_INVALID");
		branch.push(entry);
		id = entry.parentId;
	}
	return branch.reverse();
}

function sameEntries(left: readonly SessionEntry[], right: readonly SessionEntry[]): boolean {
	return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function currentSnapshot(
	snapshot: PreviewBranchSnapshot,
	branch: readonly SessionEntry[],
	leafId: string | null,
): boolean {
	return leafId === (snapshot.branch.at(-1)?.id ?? null) && sameEntries(snapshot.branch, branch);
}

/** Operational failure state only; original history remains in Pi's JSONL. */
export class PreviewFailureStore implements PreviewFailureStoreContract {
	private readonly agentDir: string;
	private readonly latched = new Map<string, string>();
	private readonly recoveryMarkers = new Map<string, Marker>();
	private readonly consumedSnapshots = new WeakSet<PreviewBranchSnapshot>();
	private readonly consumedCanonicalLines = new WeakSet<readonly Buffer[]>();
	private directory?: string;

	constructor(agentDir: string) {
		this.agentDir = resolve(agentDir);
	}

	private identity(session: PreviewSession): SessionIdentity {
		const sessionId = session.getSessionId();
		const file = session.getSessionFile();
		const header = session.getHeader();
		if (
			!identifier(sessionId) ||
			!file ||
			header?.type !== "session" ||
			header.id !== sessionId ||
			header.version !== 3
		)
			throw new PreviewStoreError("CONTEXT_PREVIEW_UNSUPPORTED");
		try {
			const canonical = canonicalSessionFile(file, session.getSessionDir());
			return { sessionId, file: canonical, sessionPathHash: digest(canonical) };
		} catch (error) {
			throw new PreviewStoreError(storeErrorCode(error, "CONTEXT_PREVIEW_SESSION_IO"));
		}
	}

	private path(identity: SessionIdentity): string {
		try {
			const directory = markerDirectory(this.agentDir);
			if (this.directory !== undefined && this.directory !== directory)
				throw new PreviewStoreError("CONTEXT_PREVIEW_MARKER_IO");
			this.directory = directory;
			return join(directory, `${digest(identity.sessionId)}.json`);
		} catch (error) {
			throw new PreviewStoreError(storeErrorCode(error, "CONTEXT_PREVIEW_MARKER_IO"));
		}
	}

	private readMarker(identity: SessionIdentity, create = true): Marker | undefined {
		let data: Buffer;
		try {
			const file = create
				? this.path(identity)
				: join(this.agentDir, "context-memory-preview", "failures", `${digest(identity.sessionId)}.json`);
			data = readBoundedFile(file, MAX_MARKER_BYTES, "CONTEXT_PREVIEW_MARKER_INVALID");
		} catch (error) {
			if (missing(error)) return undefined;
			throw new PreviewStoreError(storeErrorCode(error, "CONTEXT_PREVIEW_MARKER_IO"));
		}
		let marker: Marker;
		try {
			marker = parseMarker(JSON.parse(data.toString("utf8")));
		} catch {
			throw new PreviewStoreError("CONTEXT_PREVIEW_MARKER_INVALID");
		}
		if (marker.sessionId !== identity.sessionId || marker.sessionPathHash !== identity.sessionPathHash)
			throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_INVALID");
		return marker;
	}

	private recordFailure(session: PreviewSession, code: string, recoveryMarker?: Marker): void {
		const identity = this.identity(session);
		const persisted = this.readMarker(identity);
		if (persisted?.state === "blocked") return; // Do not replace a specific failure with the later cancellation event.
		const previous = persisted ?? recoveryMarker ?? this.recoveryMarkers.get(identity.sessionId);
		if (
			previous &&
			(previous.sessionId !== identity.sessionId || previous.sessionPathHash !== identity.sessionPathHash)
		)
			throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_INVALID");
		try {
			writeMarker(this.path(identity), {
				...(previous ?? { version: 1, sessionId: identity.sessionId, sessionPathHash: identity.sessionPathHash }),
				state: "blocked",
				code,
			} satisfies Marker);
		} catch (error) {
			throw new PreviewStoreError(storeErrorCode(error, "CONTEXT_PREVIEW_MARKER_IO"));
		}
	}

	private reject(session: PreviewSession, error: unknown, fallback: string, recoveryMarker?: Marker): never {
		const code = storeErrorCode(error, fallback);
		this.latched.set(session.getSessionId(), code);
		if (recoveryMarker?.attempt && recoveryMarker.candidateHash) {
			// If unlink succeeded but its directory fsync failed, retain the original staged identity.
			this.recoveryMarkers.set(recoveryMarker.sessionId, { ...recoveryMarker, state: "blocked", code });
		}
		try {
			this.recordFailure(session, code, recoveryMarker);
		} catch {
			// A preexisting pending marker survives failed writes; complete IO failure also latches this process.
		}
		throw new PreviewStoreError(code);
	}

	status(session: PreviewSession): PreviewStatus {
		return this.evaluate(session, true);
	}

	/** The same evaluation without latching a newly observed failure; for read-only diagnostics. */
	inspect(session: PreviewSession): PreviewStatus {
		return this.evaluate(session, false);
	}

	/** A durable or same-process claim on this session. Never creates directories or files. */
	markerPresent(session: PreviewSession): boolean {
		const sessionId = session.getSessionId();
		if (this.latched.has(sessionId) || this.recoveryMarkers.has(sessionId)) return true;
		const file = join(this.agentDir, "context-memory-preview", "failures", `${digest(sessionId)}.json`);
		try {
			lstatSync(file);
			return true;
		} catch (error) {
			// Anything other than a confirmed absence counts as a claim, so unreadable state fails closed.
			return !(isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"));
		}
	}

	private evaluate(session: PreviewSession, latch: boolean, snapshot?: PreviewBranchSnapshot): PreviewStatus {
		try {
			const identity = this.identity(session);
			const marker = this.readMarker(identity, latch);
			if (marker) return { state: marker.state, code: marker.code };
			const latched = this.latched.get(identity.sessionId);
			if (latched) return { state: "blocked", code: latched };
			// Stock Pi allocates a path before its first user message. Empty persistent sessions may start normally.
			const current =
				snapshot && currentSnapshot(snapshot, session.getBranch(), session.getLeafId()) ? snapshot : undefined;
			const disk = readSession(identity, true, current);
			if (!disk) {
				if (session.getEntries().some((entry) => entry.type === "message" || entry.type === "compaction"))
					throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_IO");
			} else {
				const leafId = session.getLeafId();
				if (leafId !== null) {
					const memoryBranch = session.getBranch();
					const diskBranch = branchAt(disk, leafId);
					const identical =
						current &&
						snapshot &&
						currentSnapshot(snapshot, memoryBranch, leafId) &&
						sameEntries(diskBranch, memoryBranch);
					if (!identical && hashEntries(diskBranch) !== hashEntries(memoryBranch))
						throw new PreviewStoreError("CONTEXT_SOURCE_CHANGED");
				}
			}
			return { state: "ready" };
		} catch (error) {
			const code = storeErrorCode(error, "CONTEXT_PREVIEW_MARKER_IO");
			if (latch) this.latched.set(session.getSessionId(), code);
			return { state: "blocked", code };
		}
	}

	assertReady(session: PreviewSession, snapshot?: PreviewBranchSnapshot): void {
		const current =
			snapshot &&
			ownedSnapshots.has(snapshot) &&
			!this.consumedSnapshots.has(snapshot) &&
			!this.consumedCanonicalLines.has(snapshot.canonicalLines)
				? snapshot
				: undefined;
		if (snapshot) {
			ownedSnapshots.delete(snapshot);
			this.consumedSnapshots.add(snapshot);
			this.consumedCanonicalLines.add(snapshot.canonicalLines);
		}
		const status = this.evaluate(session, true, current);
		if (status.state !== "ready") throw new PreviewStoreError(status.code ?? "CONTEXT_BLOCKED");
	}

	begin(session: PreviewSession, explicitRetry = false): PreviewAttempt {
		try {
			const identity = this.identity(session);
			if (!explicitRetry) this.assertReady(session);
			else {
				try {
					this.readMarker(identity);
				} catch (error) {
					// An explicit retry may replace malformed regular marker data, never a different session identity.
					if (storeErrorCode(error, "") !== "CONTEXT_PREVIEW_MARKER_INVALID") throw error;
				}
			}
			const leafId = session.getLeafId();
			const branch = session.getBranch();
			if (!identifier(leafId) || branch.at(-1)?.id !== leafId)
				throw new PreviewStoreError("CONTEXT_NO_MODEL_OR_SOURCE");
			const attempt: PreviewAttempt = {
				attemptId: randomUUID(),
				sessionId: identity.sessionId,
				leafId,
				lastCheckpointId: [...branch].reverse().find((entry) => entry.type === "compaction")?.id ?? null,
				sourceHash: hashEntries(branch),
			};
			if (hashEntries(branchAt(readSession(identity), leafId)) !== attempt.sourceHash)
				throw new PreviewStoreError("CONTEXT_SOURCE_CHANGED");
			writeMarker(this.path(identity), {
				version: 1,
				state: "pending",
				code: "CONTEXT_PREVIEW_PENDING",
				sessionId: identity.sessionId,
				sessionPathHash: identity.sessionPathHash,
				attempt,
			} satisfies Marker);
			this.recoveryMarkers.delete(identity.sessionId);
			return { ...attempt };
		} catch (error) {
			return this.reject(session, error, "CONTEXT_PREVIEW_MARKER_IO");
		}
	}

	private pending(identity: SessionIdentity): Marker & { attempt: PreviewAttempt } {
		const marker = this.readMarker(identity);
		if (marker?.state !== "pending" || !marker.attempt)
			throw new PreviewStoreError("CONTEXT_PREVIEW_COMMIT_UNCONFIRMED");
		return marker as Marker & { attempt: PreviewAttempt };
	}

	private assertCandidate(attempt: PreviewAttempt, candidate: PreviewCompaction | CompactionEntry): void {
		const details = candidate.details;
		if (
			!isRecord(details) ||
			details.kind !== CONTEXT_MEMORY_KIND ||
			details.version !== CONTEXT_MEMORY_VERSION ||
			details.coveredThrough !== attempt.leafId ||
			details.sourceHash !== attempt.sourceHash ||
			!isRecord(details.snapshot) ||
			details.snapshot.sessionId !== attempt.sessionId ||
			details.snapshot.leafId !== attempt.leafId ||
			details.snapshot.lastCheckpointId !== attempt.lastCheckpointId ||
			typeof candidate.summary !== "string" ||
			!identifier(candidate.firstKeptEntryId) ||
			!Number.isFinite(candidate.tokensBefore) ||
			candidate.tokensBefore < 0
		)
			throw new PreviewStoreError("CONTEXT_SOURCE_CHANGED");
	}

	stage(session: PreviewSession, attempt: PreviewAttempt, candidate: PreviewCompaction): void {
		try {
			const identity = this.identity(session);
			const marker = this.pending(identity);
			if (
				!sameAttempt(marker.attempt, attempt) ||
				session.getLeafId() !== attempt.leafId ||
				hashEntries(session.getBranch()) !== attempt.sourceHash
			)
				throw new PreviewStoreError("CONTEXT_SOURCE_CHANGED");
			this.assertCandidate(attempt, candidate);
			const branch = branchAt(readSession(identity), attempt.leafId);
			if (
				hashEntries(branch) !== attempt.sourceHash ||
				(candidate.firstKeptEntryId !== CONTEXT_KEEP_NONE &&
					!branch.some((entry) => entry.id === candidate.firstKeptEntryId))
			)
				throw new PreviewStoreError("CONTEXT_SOURCE_CHANGED");
			writeMarker(this.path(identity), { ...marker, candidateHash: candidateHash(candidate) } satisfies Marker);
		} catch (error) {
			this.reject(session, error, "CONTEXT_PREVIEW_MARKER_IO");
		}
	}

	commit(session: PreviewSession, entry: CompactionEntry): void {
		this.confirm(session, entry, false);
	}

	recover(session: PreviewSession, entry: CompactionEntry): void {
		this.confirm(session, entry, true);
	}

	private confirm(session: PreviewSession, entry: CompactionEntry, explicitRecovery: boolean): void {
		let recoveryMarker: Marker | undefined;
		try {
			const identity = this.identity(session);
			const persisted = this.readMarker(identity);
			const marker = persisted ?? (explicitRecovery ? this.recoveryMarkers.get(identity.sessionId) : undefined);
			recoveryMarker = marker;
			if (
				!marker?.attempt ||
				!marker.candidateHash ||
				marker.sessionId !== identity.sessionId ||
				marker.sessionPathHash !== identity.sessionPathHash ||
				(!explicitRecovery && marker.state !== "pending") ||
				entry.type !== "compaction" ||
				!identifier(entry.id) ||
				entry.parentId !== marker.attempt.leafId ||
				session.getLeafId() !== entry.id ||
				candidateHash(entry) !== marker.candidateHash
			)
				throw new PreviewStoreError("CONTEXT_PREVIEW_COMMIT_UNCONFIRMED");
			// A previous cleanup error may also have prevented its blocked marker writeback.
			// Explicit same-process recovery first restores that evidence durably, then rechecks everything.
			if (!persisted) this.recordFailure(session, marker.code, marker);
			this.assertCandidate(marker.attempt, entry);
			const disk = readSession(identity);
			const stored = disk.get(entry.id);
			if (
				stored?.type !== "compaction" ||
				stored.fromHook !== true ||
				hashEntries([stored]) !== hashEntries([entry]) ||
				candidateHash(stored) !== marker.candidateHash ||
				stored.parentId !== marker.attempt.leafId
			)
				throw new PreviewStoreError("CONTEXT_PREVIEW_COMMIT_UNCONFIRMED");
			const sources = branchAt(disk, marker.attempt.leafId);
			if (
				hashEntries(sources) !== marker.attempt.sourceHash ||
				([...sources].reverse().find((item) => item.type === "compaction")?.id ?? null) !==
					marker.attempt.lastCheckpointId ||
				hashEntries(session.getBranch()) !== hashEntries(branchAt(disk, entry.id))
			)
				throw new PreviewStoreError("CONTEXT_SOURCE_CHANGED");
			removeMarker(this.path(identity));
			this.latched.delete(identity.sessionId);
			this.recoveryMarkers.delete(identity.sessionId);
		} catch (error) {
			this.reject(session, error, "CONTEXT_PREVIEW_MARKER_IO", recoveryMarker);
		}
	}

	fail(session: PreviewSession, code: string): void {
		const controlled = CODES.has(code) ? code : "CONTEXT_WRITER_FAILED";
		this.latched.set(session.getSessionId(), controlled);
		try {
			this.recordFailure(session, controlled);
		} catch (error) {
			this.reject(session, error, "CONTEXT_PREVIEW_MARKER_IO");
		}
	}
}
