import { describe, expect, it } from "vitest";
import type { CompactionEntry, SessionEntry } from "../src/core/session-manager.ts";
import { selectNoteBudget } from "../src/extensions/context-memory/config.ts";
import {
	CONTEXT_MEMORY_KIND,
	CONTEXT_MEMORY_VERSION,
	hashEntries,
	hashEntryPrefixes,
} from "../src/extensions/context-memory/identity.ts";
import {
	inProgressRequests,
	latestMemory,
	type MemoryCheckpoint,
	type MemoryNote,
	renderContinuation,
	renderNote,
	validateMemoryCheckpoints,
} from "../src/extensions/context-memory/notes.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const originalText = "Synthetic decision: use port 4317.";

function user(id: string, parentId: string | null, content = originalText): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content, timestamp: 1 } };
}

function reply(id: string, parentId: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Synthetic progress." }],
			api: "openai-completions",
			provider: "synthetic",
			model: "validation",
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
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

function seed(): SessionEntry[] {
	return [user("user-1", null), reply("reply-1", "user-1")];
}

function checkpoint(
	branch: SessionEntry[],
	id: string,
	memoryNote = note(),
	options: { coveredThrough?: string; continuation?: string[]; noteBudget?: MemoryCheckpoint["noteBudget"] } = {},
): CompactionEntry<MemoryCheckpoint> {
	const coveredThrough = options.coveredThrough ?? branch[branch.length - 1].id;
	const end = branch.findIndex((entry) => entry.id === coveredThrough);
	const entry: CompactionEntry<MemoryCheckpoint> = {
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

function legacyPreviewLoop(branch: readonly SessionEntry[]) {
	let latest: ReturnType<typeof latestMemory>;
	for (const [index, entry] of branch.entries())
		if (entry.type === "compaction") latest = latestMemory(branch.slice(0, index + 1));
	return latest;
}

function expectSameError(branch: readonly SessionEntry[], error: string): void {
	expect(() => validateMemoryCheckpoints(branch)).toThrow(error);
	expect(() => legacyPreviewLoop(branch)).toThrow(error);
}

describe("context memory: byte-equivalent single-pass prefix hashes", () => {
	it("matches every prefix byte rule, including empty, Unicode, escapes, nested values and omitted properties", () => {
		const entries: readonly unknown[] = [
			{ text: 'Synthetic 中文 / emoji 🐙 / \n / " / \\' },
			{ nested: { value: null, numbers: [0, -0, 1.5], omitted: undefined } },
			["synthetic", null, { nested: [true, false] }],
			{ second: "b", first: "a" },
		];
		const lengths = Array.from({ length: entries.length + 1 }, (_, index) => index);
		const hashes = hashEntryPrefixes(entries, lengths);
		for (const length of lengths) expect(hashes.get(length)).toBe(hashEntries(entries.slice(0, length)));
		expect(hashEntryPrefixes([], [0]).get(0)).toBe(hashEntries([]));
	});
	it("serializes each required entry once for unordered duplicate boundaries, and omits a later tail", () => {
		const calls = [0, 0, 0, 0];
		const entries = calls.map((_, index) => ({
			toJSON() {
				calls[index]++;
				return { index };
			},
		}));
		const hashes = hashEntryPrefixes(entries, [3, 0, 1, 2, 3, 0]);
		expect(calls).toEqual([1, 1, 1, 0]);
		for (const length of [0, 1, 2, 3])
			expect(hashes.get(length)).toBe(hashEntries(Array.from({ length }, (_, index) => ({ index }))));
		expect(hashEntryPrefixes(entries, []).size).toBe(0);
		expect(calls).toEqual([1, 1, 1, 0]);
	});
	it.each([-1, 0.5, 3, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid boundary %s", (length) => {
		expect(() => hashEntryPrefixes([{}, {}], [length])).toThrow("CONTEXT_SOURCE_PREFIX");
	});
});

describe("context memory: indexed historical checkpoint validation", () => {
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
		branch.push({
			type: "label",
			id: "user-1",
			parentId: "reply-1",
			timestamp,
			targetId: "reply-1",
			label: "synthetic",
		});
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

describe("context memory: indexed continuation validation", () => {
	function unfinished() {
		const branch = seed();
		checkpoint(branch, "checkpoint-1");
		branch.push(user("user-2", "checkpoint-1", "Synthetic unfinished task."));
		branch.push(user("user-3", "user-2", "Synthetic steering."));
		branch.push({
			type: "thinking_level_change",
			id: "thinking",
			parentId: "user-3",
			timestamp,
			thinkingLevel: "medium",
		});
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
