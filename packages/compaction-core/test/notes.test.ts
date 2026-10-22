// Cloned from packages/coding-agent/test/context-memory-validation.test.ts (checkpoint and
// continuation validation) and the pure note-validation, source-sizing and lineage blocks of
// packages/coding-agent/test/context-memory.test.ts and context-memory-budget.test.ts, retargeted
// at the core copies and retyped against the structural record types. The resident tests keep
// running against the resident copies untouched; this file imports nothing from Pi, and every
// fixture is invented. Host-kind fixtures (label, thinking_level_change) are replaced by
// context_edit records, the record model's own unreadable kind.
import { describe, expect, it } from "vitest";
import { selectNoteBudget } from "../src/config.ts";
import { CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION, hashEntries } from "../src/identity.ts";
import {
	checkpointLineage,
	compactedSourceTokens,
	inProgressRequests,
	latestMemory,
	lineageSentence,
	type MemoryCheckpoint,
	type MemoryNote,
	noteSections,
	oneLineNote,
	renderContinuation,
	renderNote,
	shrinkLineage,
	validateMemoryCheckpoints,
	validateNote,
} from "../src/notes.ts";
import type { CompactionRecord, SessionRecord } from "../src/records.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const originalText = "Synthetic decision: use port 4317.";

function user(id: string, parentId: string | null, content = originalText): SessionRecord {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content } };
}

function reply(id: string, parentId: string, text = "Synthetic progress."): SessionRecord {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
	};
}

/** An unreadable record in the model's own terms: a context edit normalizes to empty text. */
function metadata(id: string, parentId: string, targetId = parentId): SessionRecord {
	return { type: "context_edit", id, parentId, timestamp, targetId, replacement: null };
}

function note(sourceId = "user-1", text = originalText): MemoryNote {
	return {
		instructions: [],
		failedPaths: [],
		reasons: [],
		state: [{ text, sources: [sourceId], quote: text }],
		nextSteps: [],
		files: [],
		gaps: [],
	};
}

function seed(): SessionRecord[] {
	return [user("user-1", null), reply("reply-1", "user-1")];
}

function checkpoint(
	branch: SessionRecord[],
	id: string,
	memoryNote = note(),
	options: { coveredThrough?: string; continuation?: string[]; noteBudget?: MemoryCheckpoint["noteBudget"] } = {},
): CompactionRecord<MemoryCheckpoint> {
	const coveredThrough = options.coveredThrough ?? branch[branch.length - 1].id;
	const end = branch.findIndex((entry) => entry.id === coveredThrough);
	const entry: CompactionRecord<MemoryCheckpoint> = {
		type: "compaction",
		id,
		parentId: branch[branch.length - 1].id,
		timestamp,
		summary: renderNote(memoryNote),
		firstKeptEntryId: branch[0].id,
		tokensBefore: 100,
		details: {
			kind: CONTEXT_MEMORY_KIND,
			version: CONTEXT_MEMORY_VERSION,
			note: memoryNote,
			coveredThrough,
			sourceHash: hashEntries(branch.slice(0, end + 1)),
			snapshot: { sessionId: "synthetic-session", leafId: branch[branch.length - 1].id, lastCheckpointId: null },
			writerModel: "synthetic/validation",
			chunkCount: 1,
			build: "synthetic-build",
			...(options.noteBudget === undefined ? {} : { noteBudget: options.noteBudget }),
			...(options.continuation === undefined ? {} : { continuation: options.continuation }),
		},
	};
	if (options.continuation !== undefined)
		entry.summary += renderContinuation(inProgressRequests(branch.slice(0, end + 1)));
	branch.push(entry);
	return entry;
}

function legacyPreviewLoop(branch: readonly SessionRecord[]) {
	let latest: ReturnType<typeof latestMemory>;
	for (const [index, entry] of branch.entries())
		if (entry.type === "compaction") latest = latestMemory(branch.slice(0, index + 1));
	return latest;
}

function expectSameError(branch: readonly SessionRecord[], error: string): void {
	expect(() => validateMemoryCheckpoints(branch)).toThrow(error);
	expect(() => legacyPreviewLoop(branch)).toThrow(error);
}

describe("compaction core: indexed historical checkpoint validation", () => {
	it("emits every canonical entry through the current tail from the same checkpoint scan", () => {
		const branch = seed();
		checkpoint(branch, "checkpoint-1");
		branch.push(user("new-user", "checkpoint-1", "A later ruling."));
		const emitted = new Map<number, string>();
		const latest = validateMemoryCheckpoints(branch, (index, serialized) => emitted.set(index, serialized));
		expect(latest?.entry.id).toBe("checkpoint-1");
		expect([...emitted.keys()]).toEqual(branch.map((_entry, index) => index));
		for (const [index, serialized] of emitted) expect(serialized).toBe(JSON.stringify(branch[index]));
	});

	it("emits canonical bytes without a checkpoint while keeping the ordinary no-checkpoint path unchanged", () => {
		const branch = seed();
		const emitted: string[] = [];
		expect(validateMemoryCheckpoints(branch, (_index, serialized) => emitted.push(serialized))).toBeUndefined();
		expect(emitted).toEqual(branch.map((entry) => JSON.stringify(entry)));
		expect(validateMemoryCheckpoints(branch)).toBeUndefined();
	});
	it("returns the same latest entry and memory references as the historical preview loop", () => {
		const branch = seed();
		checkpoint(branch, "checkpoint-1");
		branch.push(user("user-2", "checkpoint-1", "Synthetic updated decision: use port 4318."));
		const latest = checkpoint(branch, "checkpoint-2", note("user-2", "Synthetic updated decision: use port 4318."));
		const validated = validateMemoryCheckpoints(branch);
		expect(validated).toEqual(legacyPreviewLoop(branch));
		expect(validated?.entry).toBe(latest);
		expect(validated?.memory).toBe(latest.details);
		expect(latestMemory(branch)).toEqual(validated);
	});
	it("detects an older broken checkpoint even when the latest checkpoint is independently valid", () => {
		const branch = seed();
		const old = checkpoint(branch, "checkpoint-1");
		old.summary = "Invalid older synthetic summary.";
		branch.push(user("user-2", "checkpoint-1", "Synthetic later state."));
		const latest = checkpoint(branch, "checkpoint-2", note("user-2", "Synthetic later state."));
		expect(latestMemory(branch)?.entry).toBe(latest);
		expectSameError(branch, "CONTEXT_NOTE_INVALID: the restored summary does not match the validated note");
	});
	it("detects a same-leaf, same-ID source edit and rechecks fresh bytes on each invocation", () => {
		const branch = seed();
		const saved = checkpoint(branch, "checkpoint-1");
		expect(validateMemoryCheckpoints(branch)?.entry).toBe(saved);
		const original = branch[0];
		if (original.type !== "message" || original.message.role !== "user") throw new Error("Missing synthetic user");
		original.message.content = "Synthetic edited decision: use port 4318.";
		expectSameError(branch, "CONTEXT_SOURCE_CHANGED");
		saved.details!.sourceHash = hashEntries(branch.slice(0, 2));
		expectSameError(branch, "CONTEXT_NOTE_QUOTE");
	});
	it.each(["sources", "supersedes"] as const)("never admits later %s as evidence for an older checkpoint", (field) => {
		const branch = seed();
		const oldNote = note();
		oldNote.state[0][field] = ["future-user"];
		checkpoint(branch, "checkpoint-1", oldNote);
		branch.push(user("future-user", "checkpoint-1", "Synthetic future evidence."));
		const latest = checkpoint(branch, "checkpoint-2", note("future-user", "Synthetic future evidence."));
		expect(latestMemory(branch)?.entry).toBe(latest);
		expectSameError(branch, "CONTEXT_NOTE_SCOPE");
	});
	it("does not let a later duplicate source supply a quotation to an older checkpoint", () => {
		const branch = seed();
		const oldNote = note("user-1", "Synthetic future quotation.");
		checkpoint(branch, "checkpoint-1", oldNote);
		branch.push(user("user-1", "checkpoint-1", "Synthetic future quotation."));
		branch.push(reply("reply-2", "user-1"));
		const latest = checkpoint(branch, "checkpoint-2", note("user-1", "Synthetic future quotation."));
		expect(latestMemory(branch)?.entry).toBe(latest);
		expectSameError(branch, "CONTEXT_NOTE_QUOTE");
	});
	it("preserves first-ID coverage and last-historical-ID evidence semantics for duplicates", () => {
		const branch = [
			user("duplicate", null, "Synthetic first source."),
			user("duplicate", "duplicate", "Synthetic second source."),
		];
		const saved = checkpoint(branch, "checkpoint-1", note("duplicate", "Synthetic second source."), {
			coveredThrough: "duplicate",
		});
		expect(saved.details!.sourceHash).toBe(hashEntries(branch.slice(0, 1)));
		branch.push(user("duplicate", "checkpoint-1", "Synthetic future source."));
		expect(validateMemoryCheckpoints(branch)?.entry).toBe(saved);
		expect(latestMemory(branch)?.entry).toBe(saved);
	});
	it("does not loosen scope when an unreadable duplicate shadows a readable original", () => {
		const branch = seed();
		branch.push(metadata("user-1", "reply-1"));
		checkpoint(branch, "checkpoint-1", note(), { coveredThrough: "user-1" });
		branch.push(user("user-1", "checkpoint-1"));
		expectSameError(branch, "CONTEXT_NOTE_SCOPE");
	});
	it("preserves the existing citation range before the checkpoint, rather than shrinking it to coveredThrough", () => {
		const branch = seed();
		branch.push(user("later-original", "reply-1", "Synthetic historical evidence beyond the coverage boundary."));
		const historical = note("later-original", "Synthetic historical evidence beyond the coverage boundary.");
		historical.state[0].supersedes = ["user-1"];
		const saved = checkpoint(branch, "checkpoint-1", historical, { coveredThrough: "user-1" });
		expect(validateMemoryCheckpoints(branch)?.entry).toBe(saved);
		expect(latestMemory(branch)?.entry).toBe(saved);
	});
	it.each(["missing", "checkpoint-1", "future-user"])(
		"rejects missing or forward coverage boundary %s",
		(coveredThrough) => {
			const branch = seed();
			const saved = checkpoint(branch, "checkpoint-1");
			saved.details!.coveredThrough = coveredThrough;
			branch.push(user("future-user", "checkpoint-1"));
			expectSameError(branch, "CONTEXT_SOURCE_CHANGED");
		},
	);
	it("preserves schema, stored budget, size and rendered-summary checks", () => {
		const malformedSchema = seed();
		const invalid = checkpoint(malformedSchema, "checkpoint-1");
		invalid.details!.note.state = [];
		expectSameError(malformedSchema, "CONTEXT_NOTE_INVALID: writer must return the complete note schema");

		const malformedBudget = seed();
		const badBudget = checkpoint(malformedBudget, "checkpoint-1", note(), {
			noteBudget: { ...selectNoteBudget({}, 64_000, 100), hardTokens: 1 },
		});
		badBudget.details!.note.state = [];
		expectSameError(malformedBudget, "CONTEXT_NOTE_VERSION: invalid stored note budget");

		const oversized = seed();
		const large = note();
		large.state[0].text = "x".repeat(2000);
		checkpoint(oversized, "checkpoint-1", large, { noteBudget: selectNoteBudget({ noteTokens: 500 }, 64_000, 100) });
		expectSameError(oversized, "CONTEXT_NOTE_BUDGET");

		const legacyBudget = seed();
		checkpoint(legacyBudget, "checkpoint-1", large);
		expect(validateMemoryCheckpoints(legacyBudget)).toBeDefined();
	});
	it("preserves chronological error order instead of rejecting the latest invalid checkpoint first", () => {
		const branch = seed();
		const older = checkpoint(branch, "checkpoint-1");
		older.details!.note.state[0].quote = "Invented synthetic quotation.";
		branch.push(user("user-2", "checkpoint-1"));
		const newer = checkpoint(branch, "checkpoint-2");
		Object.assign(newer.details!, { version: 99 });
		expectSameError(branch, "CONTEXT_NOTE_QUOTE");
		expect(() => latestMemory(branch)).toThrow("CONTEXT_NOTE_VERSION");
	});
	it("does not hash sessions without checkpoints and preserves a final foreign checkpoint's latest-only behavior", () => {
		expect(validateMemoryCheckpoints([])).toBeUndefined();
		expect(validateMemoryCheckpoints(seed())).toBeUndefined();
		const branch = seed();
		checkpoint(branch, "checkpoint-1");
		branch.push({
			type: "compaction",
			id: "foreign",
			parentId: "checkpoint-1",
			timestamp,
			summary: "Synthetic foreign summary.",
			firstKeptEntryId: "user-1",
			tokensBefore: 100,
		});
		expect(validateMemoryCheckpoints(branch)).toBeUndefined();
		expect(latestMemory(branch)).toBeUndefined();
	});
	it("extracts a repeatedly cited source on demand once per invocation, while hashes serialize its prefix once", () => {
		const branch = seed();
		const original = branch[0];
		if (original.type !== "message" || original.message.role !== "user") throw new Error("Missing synthetic user");
		let reads = 0;
		Object.defineProperty(original.message, "content", {
			enumerable: true,
			get: () => {
				reads++;
				return originalText;
			},
		});
		for (let index = 1; index <= 3; index++) {
			checkpoint(branch, `checkpoint-${index}`);
			if (index < 3) branch.push(reply(`reply-${index + 1}`, `checkpoint-${index}`));
		}
		reads = 0;
		expect(validateMemoryCheckpoints(branch)).toBeDefined();
		expect(reads).toBe(3); // One JSON serialization and sourceText's two string reads, shared across all quotes.
		expect(validateMemoryCheckpoints(branch)).toBeDefined();
		expect(reads).toBe(6); // No source or hash cache persists to a later invocation.
	});
});

describe("compaction core: indexed continuation validation", () => {
	function unfinished() {
		const branch = seed();
		checkpoint(branch, "checkpoint-1");
		branch.push(user("user-2", "checkpoint-1", "Synthetic unfinished task."));
		branch.push(user("user-3", "user-2", "Synthetic steering."));
		branch.push(metadata("thinking", "user-3"));
		const current = note("user-2", "Synthetic unfinished task.");
		current.nextSteps = [{ text: "Continue the synthetic unfinished task.", sources: ["user-2", "user-3"] }];
		const saved = checkpoint(branch, "checkpoint-2", current, { continuation: ["user-2", "user-3"] });
		return { branch, saved };
	}
	it("matches prior active-request ordering through a metadata leaf and earlier checkpoints", () => {
		const { branch, saved } = unfinished();
		expect(validateMemoryCheckpoints(branch)?.entry).toBe(saved);
		expect(legacyPreviewLoop(branch)?.entry).toBe(saved);
		expect(latestMemory(branch)?.entry).toBe(saved);
	});
	it.each(["order", "missing-request", "empty", "no-next-step", "suffix"])(
		"rejects invalid continuation %s",
		(change) => {
			const { branch, saved } = unfinished();
			if (change === "order") saved.details!.continuation = ["user-3", "user-2"];
			if (change === "missing-request") saved.details!.continuation = ["user-2"];
			if (change === "empty") saved.details!.continuation = [];
			if (change === "suffix") saved.summary += "\nUnexpected synthetic suffix.";
			if (change === "no-next-step") {
				saved.details!.note.nextSteps = [];
				saved.summary =
					renderNote(saved.details!.note) + renderContinuation(inProgressRequests(branch.slice(0, -1)));
			}
			expectSameError(branch, "CONTEXT_CONTINUATION_MISSING");
		},
	);
	it("uses coveredThrough rather than a later completed response when selecting active requests", () => {
		const branch = seed();
		branch.push(user("user-2", "reply-1", "Synthetic active request."));
		branch.push(reply("later-completion", "user-2"));
		const current = note("user-2", "Synthetic active request.");
		current.nextSteps = [{ text: "Continue synthetic work.", sources: ["user-2"] }];
		const saved = checkpoint(branch, "checkpoint-1", current, { coveredThrough: "user-2", continuation: ["user-2"] });
		expect(validateMemoryCheckpoints(branch)?.entry).toBe(saved);
		expect(latestMemory(branch)?.entry).toBe(saved);
	});
	it("rejects an asserted continuation after all requests have completed", () => {
		const branch = seed();
		checkpoint(branch, "checkpoint-1", note(), { continuation: [] });
		expectSameError(branch, "CONTEXT_CONTINUATION_MISSING");
	});
});

describe("compaction core: note validation over the branch", () => {
	const rulingText = "Use port 4317; port 9000 was rejected after the collision.";
	function candidate(sourceId: string, text = rulingText): MemoryNote {
		return {
			instructions: [],
			failedPaths: [],
			reasons: [],
			state: [{ text, sources: [sourceId] }],
			nextSteps: [],
			files: [],
			gaps: [],
		};
	}
	function conversation(suffix = ""): SessionRecord[] {
		return [
			user(`user-ruling${suffix}`, null, rulingText),
			reply(`reply-a${suffix}`, `user-ruling${suffix}`),
			user(`user-continue${suffix}`, `reply-a${suffix}`, "Continue with that decision."),
			reply(`reply-b${suffix}`, `user-continue${suffix}`, "Ready."),
		];
	}

	it("notes reject forged citations and inaccurate quotations", () => {
		const branch = conversation();
		expect(() => validateNote(candidate("not-an-entry"), branch)).toThrow("CONTEXT_NOTE_SCOPE");
		const forged = candidate("user-ruling");
		forged.state[0].quote = "Use port 9000";
		expect(() => validateNote(forged, branch)).toThrow("CONTEXT_NOTE_QUOTE");
	});

	it("supersedes uses the same readable-source boundary as sources in every note section", () => {
		const branch = conversation();
		branch.push(metadata("metadata-1", "reply-b"));
		branch.push({
			type: "custom",
			id: "custom-1",
			parentId: "metadata-1",
			timestamp,
			customType: "test-metadata",
			data: {},
		});
		branch.push(user("empty-user", "custom-1", ""));
		branch.push({
			type: "compaction",
			id: "prior-checkpoint",
			parentId: "empty-user",
			timestamp,
			summary: "Prior summary",
			firstKeptEntryId: "user-ruling",
			tokensBefore: 1,
		});
		branch.push(...conversation("-2"));
		const current = "user-ruling-2";
		for (const section of noteSections) {
			for (const invalid of ["metadata-1", "custom-1", "empty-user", "prior-checkpoint", "not-in-branch"]) {
				const unavailable = candidate(current);
				unavailable[section] = [{ text: "Current ruling", sources: [current], supersedes: [invalid] }];
				expect(() => validateNote(unavailable, branch)).toThrow("CONTEXT_NOTE_SCOPE");
				unavailable[section] = [{ text: "Current ruling", sources: [invalid] }];
				expect(() => validateNote(unavailable, branch)).toThrow("CONTEXT_NOTE_SCOPE");
			}
			const valid = candidate(current);
			valid[section] = [{ text: "Current ruling", sources: [current], supersedes: ["user-ruling"] }];
			expect(validateNote(valid, branch)).toEqual(valid);
		}
	});
	it("supersedes rejects originals outside the provided prefix", () => {
		const branch = conversation();
		const prefix = structuredClone(branch);
		branch.push(...conversation("-future"));
		const outside = candidate("user-ruling");
		outside.state[0].supersedes = ["user-ruling-future"];
		expect(() => validateNote(outside, prefix)).toThrow("CONTEXT_NOTE_SCOPE");
	});

	it("source sizing ignores image bytes and hidden thinking signatures", () => {
		const branch = conversation();
		const before = compactedSourceTokens(branch);
		branch.push({
			type: "message",
			id: "image-entry",
			parentId: "reply-b",
			timestamp,
			message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "A".repeat(900_000) }] },
		});
		branch.push({
			type: "message",
			id: "thinking-entry",
			parentId: "image-entry",
			timestamp,
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: "private".repeat(100_000), thinkingSignature: "A".repeat(900_000) },
				],
			},
		});
		expect(compactedSourceTokens(branch) - before).toBeLessThan(100);
	});
});

describe("compaction core: checkpoint lineage and rendering", () => {
	function twoPhases() {
		const branch = seed();
		const first = checkpoint(branch, "checkpoint-1");
		branch.push(user("user-2", "checkpoint-1", "Now document the deploy script."));
		branch.push(reply("reply-2", "user-2", "Documented."));
		branch.push(metadata("metadata-leaf", "reply-2"));
		const second: MemoryNote = {
			instructions: [],
			failedPaths: [],
			reasons: [],
			state: [{ text: "Deploy script documented.\n- dry-run first\n- then release. Tag it.", sources: ["user-2"] }],
			nextSteps: [],
			files: [],
			gaps: [],
		};
		const folded = oneLineNote(second);
		const saved = checkpoint(branch, "checkpoint-2", folded, { coveredThrough: "metadata-leaf" });
		return { branch, first, saved, folded };
	}
	it("anchors earlier checkpoints on readable originals and folds writer line breaks before commit", () => {
		const { branch, saved, folded } = twoPhases();
		expect(folded.state[0].text).toBe("Deploy script documented. - dry-run first - then release. Tag it.");
		expect(validateMemoryCheckpoints(branch)?.entry).toBe(saved);
		const lineage = checkpointLineage(branch);
		expect(lineage.map((item) => item.checkpointId)).toEqual(["checkpoint-1", "checkpoint-2"]);
		// checkpoint-1 covers through a readable reply; checkpoint-2's coveredThrough is an unreadable
		// metadata record, so its anchor walks back to the nearest readable original.
		expect(lineage.map((item) => item.anchor)).toEqual(["reply-1", "reply-2"]);
		expect(lineage[1].state).toEqual(["Deploy script documented."]);
		const rendered = renderNote(folded, lineage);
		expect(rendered).toContain(
			`## priorCheckpoints\nEarlier checkpoints on this branch, oldest first, reduced to their opening state lines. Their originals are still on disk: search context_history for these topics. The IDs are search anchors, not citable sources; cite only IDs from the handover manifest.\n- through reply-1: ${originalText}`,
		);
		expect(renderNote(folded)).not.toContain("priorCheckpoints");
	});
	it("trims middle checkpoints first and the newest last under the lineage token budget", () => {
		const { branch, first } = twoPhases();
		const items = ["a", "b", "c", "d"].map((id) => ({ checkpointId: id, anchor: id, state: [] }));
		expect(shrinkLineage(items).map((item) => item.checkpointId)).toEqual(["a", "c", "d"]);
		expect(shrinkLineage(shrinkLineage(shrinkLineage(items))).map((item) => item.checkpointId)).toEqual(["a"]);
		expect(checkpointLineage(branch, 80).map((item) => item.checkpointId)).toEqual([]);
		expect(checkpointLineage(branch, 120).map((item) => item.checkpointId)).toEqual([first.id]);
	});
	it("bounds lineage sentences by estimated tokens so CJK text costs the same budget share as ASCII", () => {
		expect(lineageSentence("第一句。第二句。")).toBe("第一句。");
		expect(lineageSentence("Alpha beta!  gamma")).toBe("Alpha beta!");
		const long = lineageSentence("很长的一句话".repeat(40));
		expect(long.endsWith("…")).toBe(true);
		expect(Buffer.byteLength(long, "utf8") / 3).toBeLessThanOrEqual(50);
	});
});
