import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseSessionEntries, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type ConformanceVector,
	checkpointBranch,
	type Outcome,
	runCoreVector,
	type Serialization,
} from "../../packages/compaction-core/conformance/runner.ts";
import { hashCanonicalRecords } from "../../packages/compaction-core/src/canonical.ts";
import { errorCode, PROJECT_CODES } from "../../packages/compaction-core/src/events.ts";
import { assertToolPairs } from "../../packages/compaction-core/src/guards.ts";
import { removeNoteEnvelope } from "../../packages/compaction-core/src/note-envelope.ts";
import {
	hashEntries,
	latestMemory,
	type MemoryNote,
	validateMemoryCheckpoints,
	validateNoteContent,
} from "../../packages/compaction-core/src/notes.ts";
import { diagnoseQuotes } from "../../packages/compaction-core/src/quote-diagnostics.ts";
import type { SessionRecord } from "../../packages/compaction-core/src/records.ts";
import { diagnoseScope } from "../../packages/compaction-core/src/scope-diagnostics.ts";
import { assertUserMessages } from "../../packages/compaction-core/src/work-notes.ts";
import { toPiSession } from "./pi-session.ts";
import { parseRecords, RECORDS_FORMAT, type RecordsHeader, serializeRecords } from "./records.ts";

/**
 * The Pi-adapter path of the 0.7 conformance vectors (WP3): each vector's host-neutral records are written as a
 * records file, rendered as a Pi version-3 session by the fixture converter, loaded by Pi's SessionManager and widened
 * to records at the boundary exactly as the preview does; then the stage's validation runs over those Pi entries and
 * its outcome class must equal the vector's expectation, the one the core path (conformance/runner.ts) reaches.
 */

const conformance = new URL("../../packages/compaction-core/conformance/", import.meta.url);
const manifest: { files: Record<string, string> } = JSON.parse(
	readFileSync(new URL("manifest.json", conformance), "utf8"),
);
const vectorBytes = readFileSync(new URL("vectors.json", conformance));
const vectors: ConformanceVector[] = JSON.parse(vectorBytes.toString("utf8"));

/** Invented session metadata (K12): no real identifier or path. */
const HEADER: RecordsHeader = {
	format: RECORDS_FORMAT,
	session: { id: "synthetic-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "synthetic-cwd" },
};

/** Vectors the converter cannot represent: a records file holds at least one record (EVAL_RECORDS_EMPTY). */
const ADAPTER_SKIPS: Record<string, string> = {
	"sources-absent": "zero records: the converter rejects an empty records file (EVAL_RECORDS_EMPTY)",
	"sources-empty": "zero records: the converter rejects an empty records file (EVAL_RECORDS_EMPTY)",
	"sources-missing": "zero records: the converter rejects an empty records file (EVAL_RECORDS_EMPTY)",
};

/** Pi's entries satisfy the core's structural record shapes; the union is widened, never converted (records.ts). */
const asRecords = (entries: readonly SessionEntry[]): readonly SessionRecord[] =>
	entries as unknown as readonly SessionRecord[];

/** Records file, converter, Pi's session parser and SessionManager: the branch the preview would read. */
function piSession(records: readonly SessionRecord[]): SessionManager {
	const text = toPiSession(parseRecords(serializeRecords({ header: HEADER, records: [...records] })));
	return SessionManager.inMemory(HEADER.session.cwd, undefined, parseSessionEntries(text));
}

const piBranch = (records: readonly SessionRecord[]): SessionRecord[] => [...asRecords(piSession(records).getBranch())];

/** The runner's outcome mapping: a project code is a refusal, anything else is a defect of the test. */
function classify(run: () => void): Outcome {
	try {
		run();
		return { outcome: "commit" };
	} catch (error) {
		const code = errorCode(error instanceof Error ? error.message : undefined);
		if (!PROJECT_CODES.has(code)) throw error;
		return { outcome: "refusal", code };
	}
}

/** The checkpoint's sourceHash, computed at assembly time over the converted Pi entries it covers. */
function sourceHash(entries: readonly SessionRecord[], serialization: Serialization): string {
	return serialization === "jcs" ? hashCanonicalRecords(entries) : hashEntries(entries);
}

type CheckpointVector = Extract<ConformanceVector, { stage: "checkpoint" }>;

/** The vector's checkpoint over `records`, carrying `hash`, with the whole branch rendered through the converter. */
function piCheckpointBranch(
	vector: CheckpointVector,
	serialization: Serialization,
	records: readonly SessionRecord[],
	hash: string,
): SessionRecord[] {
	const hashed = { ...vector, checkpoint: { ...vector.checkpoint, sourceHashes: { [serialization]: hash } } };
	return piBranch(checkpointBranch(hashed, serialization, [...records]));
}

/** What the preview does when it opens a session: assertPreviewSession's checkpoint and user-message checks. */
function openCheckpoint(branch: readonly SessionRecord[], serialization: Serialization): void {
	validateMemoryCheckpoints(branch, undefined, serialization);
	assertUserMessages(branch);
}

/** The adapter path per stage family; every validator sees Pi entries the converter produced. */
function runAdapterVector(vector: ConformanceVector, serialization: Serialization): Outcome {
	switch (vector.stage) {
		case "checkpoint": {
			// A changed-source checkpoint was written over the original session; any other over its own records.
			const hash = sourceHash(piBranch(vector.originalRecords ?? vector.records), serialization);
			return classify(() =>
				openCheckpoint(piCheckpointBranch(vector, serialization, vector.records, hash), serialization),
			);
		}
		case "tool-pairs": {
			// Pairing is decided on the projection Pi builds for the next request, as the preview asserts it before
			// compacting, not on the records' messages; the candidate then takes the plain note stage.
			const projected = classify(() => assertToolPairs(piSession(vector.records).buildSessionProjection().messages));
			if (projected.outcome === "refusal") return projected;
			return runCoreVector({ ...vector, stage: "note", records: piBranch(vector.records) });
		}
		default:
			// Note validation, budget, envelope removal and the scripted repairs, over the converted branch.
			return runCoreVector({ ...vector, records: piBranch(vector.records) });
	}
}

const serializationsOf = (vector: ConformanceVector): Serialization[] =>
	vector.stage === "checkpoint" ? (Object.keys(vector.checkpoint.sourceHashes) as Serialization[]) : ["pi"];

describe("0.7-conformance.1 through the Pi converter", () => {
	it("reads the pinned vector set, and skips on this path only the vectors the converter cannot represent", () => {
		expect(createHash("sha256").update(vectorBytes).digest("hex")).toBe(manifest.files["vectors.json"]);
		expect(vectors).toHaveLength(34);
		const empty = vectors.filter((vector) => vector.records.length === 0).map((vector) => vector.id);
		expect(empty).toEqual(Object.keys(ADAPTER_SKIPS));
		for (const id of empty) {
			const vector = vectors.find((item) => item.id === id)!;
			expect(() => serializeRecords({ header: HEADER, records: vector.records }), id).toThrow("EVAL_RECORDS_EMPTY");
			// Covered by the core runner instead, with the expected class.
			expect(runCoreVector(vector), id).toEqual(vector.expected);
		}
	});

	for (const vector of vectors) {
		if (vector.id in ADAPTER_SKIPS) {
			it.skip(`${vector.id}: ${ADAPTER_SKIPS[vector.id]}`, () => {});
			continue;
		}
		for (const serialization of serializationsOf(vector)) {
			it(`${vector.id} (${serialization}) agrees with the core path`, () => {
				const before = structuredClone(vector);
				const branch = piBranch(vector.records);
				// The validators see Pi's entries, not the vector's bytes: messages carry Pi's derived fields,
				// other kinds pass through as Pi's native entry shape.
				expect(branch.map((entry) => entry.id)).toEqual(vector.records.map((record) => record.id));
				for (const [index, entry] of branch.entries())
					if (entry.type === "message")
						expect(JSON.stringify(entry), entry.id).not.toBe(JSON.stringify(vector.records[index]));
					else expect(entry, entry.id).toEqual(vector.records[index]);
				if (vector.stage === "note" && vector.diagnosis) {
					const note = removeNoteEnvelope(structuredClone(vector.candidate)).value as MemoryNote;
					if (vector.diagnosis.scope) expect(diagnoseScope(note, branch)).toEqual(vector.diagnosis.scope);
					if (vector.diagnosis.quote)
						expect(diagnoseQuotes(note, branch).failures.map((failure) => failure.kind)).toEqual([
							vector.diagnosis.quote,
						]);
				}
				if (vector.stage === "checkpoint") {
					const pinned = vector.checkpoint.sourceHashes[serialization];
					const computed = sourceHash(piBranch(vector.originalRecords ?? vector.records), serialization);
					// Pi's framing covers the converter's derived fields; the canonical form excludes them.
					if (serialization === "pi") expect(computed).not.toBe(pinned);
					else expect(computed).toBe(pinned);
				}
				if (vector.stage === "checkpoint" && vector.originalRecords) {
					const hash = sourceHash(piBranch(vector.originalRecords), serialization);
					const original = piCheckpointBranch(vector, serialization, vector.originalRecords, hash);
					expect(classify(() => openCheckpoint(original, serialization))).toEqual({ outcome: "commit" });
					expect(latestMemory(original, serialization)?.entry.id).toBe("checkpoint-1");
					// The edited Pi entries still support the exact quotation: only the stored hash may refuse.
					expect(() => validateNoteContent(vector.candidate, branch)).not.toThrow();
				}
				expect(runAdapterVector(vector, serialization)).toEqual(vector.expected);
				expect(runCoreVector(vector, serialization)).toEqual(vector.expected);
				expect(vector).toEqual(before);
			});
		}
	}
});
