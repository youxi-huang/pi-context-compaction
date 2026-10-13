import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { selectNoteBudget } from "../src/extensions/context-memory/config.ts";
import { hashEntries } from "../src/extensions/context-memory/identity.ts";
import type { MemoryNote } from "../src/extensions/context-memory/notes.ts";
import {
	classifyPreparation,
	finalizePreparation,
	freezePreparationInput,
	type PreparationInput,
	type PreparationSubmission,
	type PreparationWriterIdentity,
} from "../src/extensions/context-memory/preview/preparation-candidate.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const sourceText = "Synthetic service uses port 4317.";

function user(id: string, parentId: string | null, text = sourceText): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content: text, timestamp: 1 } };
}

function reply(id: string, parentId: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			api: "openai-completions",
			provider: "synthetic",
			model: "preparation",
			content: [{ type: "text", text: "Synthetic progress is recorded." }],
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

function branch(): SessionEntry[] {
	return [user("user-1", null), reply("reply-1", "user-1")];
}

function writer(overrides: Partial<PreparationWriterIdentity> = {}): PreparationWriterIdentity {
	return {
		role: "fixed",
		model: "synthetic/preparation",
		effort: "medium",
		policyHash: "synthetic-policy",
		promptHash: "synthetic-prompt",
		schemaHash: "synthetic-schema",
		contextHash: null,
		...overrides,
	};
}

function input(overrides: Partial<PreparationInput> = {}): PreparationInput {
	return {
		sessionId: "synthetic-session",
		epoch: 3,
		branch: branch(),
		coveredThrough: "reply-1",
		processedUserEntryIds: ["user-1"],
		writer: writer(),
		noteBudget: selectNoteBudget({}, 64_000, 100),
		...overrides,
	};
}

function submission(overrides: Partial<PreparationSubmission> = {}): PreparationSubmission {
	return {
		sessionId: "synthetic-session",
		epoch: 3,
		branch: branch(),
		writer: writer(),
		noteBudget: selectNoteBudget({}, 64_000, 100),
		...overrides,
	};
}

function note(): MemoryNote {
	return {
		instructions: [],
		failedPaths: [],
		reasons: [],
		state: [{ text: sourceText, sources: ["user-1"], quote: sourceText }],
		nextSteps: [],
		files: [],
		gaps: [],
	};
}

function provenance(identity = writer()) {
	return {
		writerRole: identity.role,
		writerModel: identity.model,
		writerEffort: identity.effort,
		callIds: ["synthetic-call-1"],
	};
}

function candidate(options: Partial<PreparationInput> = {}, resultNote = note()) {
	const frozen = freezePreparationInput(input(options));
	return finalizePreparation(frozen, { note: resultNote, provenance: provenance(options.writer) });
}

describe("independent preview preparation: immutable candidates", () => {
	it("freezes a cloned input before a note exists and binds deterministic identities", () => {
		const original = input();
		const frozen = freezePreparationInput(original);
		expect(frozen).not.toHaveProperty("note");
		expect(frozen.candidateId).toBe(freezePreparationInput(input()).candidateId);
		expect(frozen.coverage.sourceHash).toBe(hashEntries(original.branch));
		expect(frozen.coverage.originalIds).toEqual(["user-1", "reply-1"]);
		expect(frozen.userHorizon.entryIds).toEqual(["user-1"]);
		expect(Object.isFrozen(frozen)).toBe(true);
		expect(Object.isFrozen(frozen.sources[0])).toBe(true);
		expect(Object.isFrozen(frozen.writer)).toBe(true);
		expect(Object.isFrozen(frozen.userHorizon.entryIds)).toBe(true);
		expect(Reflect.set(frozen.writer, "promptHash", "changed")).toBe(false);
		const first = original.branch[0];
		if (first.type !== "message" || first.message.role !== "user") throw new Error("Missing synthetic user");
		first.message.content = "Changed after dispatch.";
		original.writer.promptHash = "changed";
		original.noteBudget.hardTokens = 500;
		expect(frozen.coverage.sourceHash).toBe(hashEntries(branch()));
		expect(frozen.writer.promptHash).toBe("synthetic-prompt");
		expect(frozen.noteBudget.hardTokens).toBe(4000);
		expect(frozen.candidateId).not.toBe(freezePreparationInput(input({ sessionId: "other-session" })).candidateId);
		expect(frozen.candidateId).not.toBe(freezePreparationInput(input({ epoch: 4 })).candidateId);
	});
	it("freezes the finalized output and preserves actual writer/accounting provenance", () => {
		const original = note();
		const actual = provenance();
		const finalized = finalizePreparation(freezePreparationInput(input()), { note: original, provenance: actual });
		original.state[0].text = "Changed after completion.";
		actual.callIds.push("later-call");
		expect(finalized.note.state[0].text).toBe(sourceText);
		expect(finalized.provenance.callIds).toEqual(["synthetic-call-1"]);
		expect(finalized.provenance.writerModel).toBe("synthetic/preparation");
		expect(Object.isFrozen(finalized.note.state[0].sources)).toBe(true);
		expect(Object.isFrozen(finalized.provenance.callIds)).toBe(true);
		expect(Reflect.set(finalized.note.state[0], "text", "changed")).toBe(false);
		expect(finalized.noteHash).toBe(hashEntries([note()]));
		expect(finalized.outputHash).toBe(
			hashEntries([
				{
					candidateId: finalized.input.candidateId,
					noteHash: finalized.noteHash,
					provenanceHash: finalized.provenanceHash,
				},
			]),
		);
	});
	it("normalizes control metadata before hashing independently of object property order", () => {
		const selected = input();
		const reversedWriter = Object.fromEntries(
			Object.entries(selected.writer).reverse(),
		) as unknown as PreparationWriterIdentity;
		const reversedBudget = {
			hardTokens: selected.noteBudget.hardTokens,
			baseTokens: selected.noteBudget.baseTokens,
			previousTokens: selected.noteBudget.previousTokens,
			sourceTokens: selected.noteBudget.sourceTokens,
			tier: selected.noteBudget.tier,
			mode: selected.noteBudget.mode,
			version: selected.noteBudget.version,
		};
		expect(freezePreparationInput(input({ writer: reversedWriter, noteBudget: reversedBudget })).candidateId).toBe(
			freezePreparationInput(selected).candidateId,
		);
	});
	it("rejects invalid ancestry and unordered, duplicate or future user horizons at dispatch", () => {
		const sibling = branch();
		sibling[1].parentId = null;
		expect(() => freezePreparationInput(input({ branch: sibling }))).toThrow(/CONTEXT_PREPARATION_INPUT/);
		for (const processedUserEntryIds of [["reply-1"], ["user-1", "user-1"], ["future-user"]])
			expect(() => freezePreparationInput(input({ processedUserEntryIds }))).toThrow(/CONTEXT_PREPARATION_INPUT/);
		const extended = [...branch(), user("user-2", "reply-1")];
		expect(() =>
			freezePreparationInput(
				input({ branch: extended, coveredThrough: "user-2", processedUserEntryIds: ["user-2", "user-1"] }),
			),
		).toThrow(/CONTEXT_PREPARATION_INPUT/);
	});
	it.each(["writerModel", "writerRole", "writerEffort"] as const)("refuses mismatched actual %s", (field) => {
		const actual = provenance();
		if (field === "writerModel") actual.writerModel = "unknown/other-writer";
		if (field === "writerRole") actual.writerRole = "session";
		if (field === "writerEffort") actual.writerEffort = "off";
		expect(() => finalizePreparation(freezePreparationInput(input()), { note: note(), provenance: actual })).toThrow(
			/CONTEXT_PREPARATION_WRITER/,
		);
	});
	it("refuses missing or ambiguous paid-call accounting links", () => {
		for (const actual of [
			{ ...provenance(), callIds: [] },
			{ ...provenance(), callIds: ["same", "same"] },
		]) {
			expect(() =>
				finalizePreparation(freezePreparationInput(input()), { note: note(), provenance: actual }),
			).toThrow(/CONTEXT_PREPARATION_PROVENANCE/);
		}
	});
});

describe("independent preview preparation: frozen note scope", () => {
	it.each(["sources", "supersedes"] as const)(
		"rejects %s from a later tail even when it exists at dispatch",
		(field) => {
			const extended = [...branch(), user("user-2", "reply-1", "Synthetic updated port is 4318.")];
			const frozen = freezePreparationInput(input({ branch: extended }));
			const future = note();
			future.state[0][field] = ["user-2"];
			expect(() => finalizePreparation(frozen, { note: future, provenance: provenance() })).toThrow(
				/CONTEXT_NOTE_SCOPE/,
			);
		},
	);
	it("rejects invented exact quotations and malformed notes", () => {
		const incorrect = note();
		incorrect.state[0].quote = "Synthetic service uses port 4318.";
		expect(() => candidate({}, incorrect)).toThrow(/CONTEXT_NOTE_QUOTE/);
		expect(() =>
			finalizePreparation(freezePreparationInput(input()), { note: {}, provenance: provenance() }),
		).toThrow(/CONTEXT_NOTE_INVALID/);
	});
	it("rejects output beyond the frozen preparation budget", () => {
		const large = note();
		large.state[0].text = "x".repeat(2000);
		expect(() => candidate({ noteBudget: selectNoteBudget({ noteTokens: 500 }, 64_000, 100) }, large)).toThrow(
			/CONTEXT_NOTE_BUDGET/,
		);
	});
	it("accepts in-prefix supersession references but does not attest their meaning", () => {
		const extended = [...branch(), user("user-2", "reply-1", "Synthetic updated port is 4318.")];
		const updated = note();
		updated.state[0] = {
			text: "Synthetic updated port is 4318.",
			sources: ["user-2"],
			quote: "Synthetic updated port is 4318.",
			supersedes: ["user-1"],
		};
		const prepared = candidate(
			{ branch: extended, coveredThrough: "user-2", processedUserEntryIds: ["user-1", "user-2"] },
			updated,
		);
		expect(classifyPreparation(prepared, submission({ branch: extended }))).toEqual({
			status: "current-full",
			reason: "complete",
		});
	});
});

describe("independent preview preparation: submission eligibility", () => {
	it("classifies a source-identical complete delivered horizon as current", () => {
		expect(classifyPreparation(candidate(), submission())).toEqual({ status: "current-full", reason: "complete" });
	});
	it("detects source tampering despite unchanged leaf, IDs and parent links", () => {
		const changed = branch();
		const first = changed[0];
		if (first.type !== "message" || first.message.role !== "user") throw new Error("Missing synthetic user");
		first.message.content = "Synthetic updated port is 4318.";
		expect(classifyPreparation(candidate(), submission({ branch: changed }))).toEqual({
			status: "invalid",
			reason: "source-changed",
		});
	});
	it("rejects another session, preparation epoch and sibling ancestry", () => {
		const prepared = candidate();
		expect(classifyPreparation(prepared, submission({ sessionId: "other-session" }))).toEqual({
			status: "invalid",
			reason: "session-changed",
		});
		expect(classifyPreparation(prepared, submission({ epoch: 4 }))).toEqual({
			status: "invalid",
			reason: "epoch-changed",
		});
		const sibling = branch();
		sibling[1].parentId = "sibling-parent";
		expect(classifyPreparation(prepared, submission({ branch: sibling }))).toEqual({
			status: "invalid",
			reason: "branch-changed",
		});
		expect(classifyPreparation(prepared, submission({ branch: [user("other-user", null)] }))).toEqual({
			status: "invalid",
			reason: "branch-changed",
		});
	});
	it("keeps an old-prefix completion reusable after a new user arrives, with generation required", () => {
		const active = branch();
		const frozen = freezePreparationInput(input({ branch: active }));
		active.push(user("user-2", "reply-1", "Synthetic updated port is 4318."));
		const completedLate = finalizePreparation(frozen, { note: note(), provenance: provenance() });
		expect(classifyPreparation(completedLate, submission({ branch: active }))).toEqual({
			status: "stale-reusable",
			reason: "new-user-input",
		});
		expect(completedLate.input.coverage.coveredThrough).toBe("reply-1");
		expect(completedLate.input.userHorizon.entryIds).toEqual(["user-1"]);
	});
	it("requires merging new originals, metadata or context edits rather than enabling historical-prefix commits", () => {
		const tails: SessionEntry[] = [
			reply("later-reply", "reply-1"),
			{ type: "label", id: "label", parentId: "reply-1", timestamp, targetId: "user-1", label: "synthetic" },
			{ type: "context_edit", id: "edit", parentId: "reply-1", timestamp, targetId: "reply-1", replacement: null },
		];
		for (const tail of tails)
			expect(classifyPreparation(candidate(), submission({ branch: [...branch(), tail] }))).toEqual({
				status: "stale-reusable",
				reason: "new-sources",
			});
	});
	it("requires merging when the declared delivered user horizon is incomplete", () => {
		expect(classifyPreparation(candidate({ processedUserEntryIds: [] }), submission())).toEqual({
			status: "stale-reusable",
			reason: "user-horizon-incomplete",
		});
	});
	it("accepts different budget tiers and hard limits when the note fits", () => {
		const prepared = candidate();
		const larger = selectNoteBudget({}, 64_000, 100_000);
		expect(larger.tier).not.toBe(prepared.input.noteBudget.tier);
		expect(classifyPreparation(prepared, submission({ noteBudget: larger }))).toEqual({
			status: "current-full",
			reason: "complete",
		});
		expect(
			classifyPreparation(prepared, submission({ noteBudget: selectNoteBudget({ noteTokens: 500 }, 64_000, 100) })),
		).toEqual({
			status: "current-full",
			reason: "complete",
		});
	});
	it("requires a rewrite for a smaller submission hard limit without losing source-valid preparation", () => {
		const large = note();
		large.state[0].text = "x".repeat(2000);
		const prepared = candidate({}, large);
		expect(
			classifyPreparation(prepared, submission({ noteBudget: selectNoteBudget({ noteTokens: 500 }, 64_000, 100) })),
		).toEqual({
			status: "stale-reusable",
			reason: "submission-budget",
		});
	});
	it.each(["model", "effort", "policyHash", "promptHash", "schemaHash", "contextHash", "role"] as const)(
		"invalidates provenance-affecting writer %s changes",
		(field) => {
			const changed = writer();
			if (field === "model") changed.model = "unknown/other-writer";
			if (field === "effort") changed.effort = "off";
			if (field === "role") {
				changed.role = "session";
				changed.contextHash = "synthetic-context";
			}
			if (field === "contextHash") changed.contextHash = "synthetic-context";
			if (field === "policyHash" || field === "promptHash" || field === "schemaHash") changed[field] = "changed";
			expect(classifyPreparation(candidate(), submission({ writer: changed }))).toEqual({
				status: "invalid",
				reason: "writer-changed",
			});
		},
	);
	it("refuses unknown writer selectors, missing session context identity and invalid submission budgets", () => {
		expect(() => freezePreparationInput(input({ writer: writer({ model: "session" }) }))).toThrow(
			/CONTEXT_PREPARATION_INPUT/,
		);
		expect(() => freezePreparationInput(input({ writer: writer({ role: "session", contextHash: null }) }))).toThrow(
			/CONTEXT_PREPARATION_INPUT/,
		);
		expect(classifyPreparation(candidate(), submission({ writer: writer({ model: "session" }) }))).toEqual({
			status: "invalid",
			reason: "configuration-invalid",
		});
		expect(
			classifyPreparation(
				candidate(),
				submission({ noteBudget: { ...selectNoteBudget({}, 64_000, 100), hardTokens: 1 } }),
			),
		).toEqual({ status: "invalid", reason: "configuration-invalid" });
	});
	it("requires generation for custom instructions received only at submission", () => {
		expect(
			classifyPreparation(
				candidate(),
				submission({ customInstructions: "Preserve synthetic diagnostic progress." }),
			),
		).toEqual({
			status: "stale-reusable",
			reason: "custom-instructions",
		});
	});
	it("binds preceding checkpoint content and rejects a later checkpoint", () => {
		const base: SessionEntry = {
			type: "compaction",
			id: "checkpoint-1",
			parentId: "reply-1",
			timestamp,
			summary: "Synthetic checkpoint state.",
			firstKeptEntryId: "reply-1",
			tokensBefore: 100,
		};
		const checkpointBranch = [...branch(), base, user("user-2", "checkpoint-1")];
		const prepared = candidate({
			branch: checkpointBranch,
			coveredThrough: "user-2",
			processedUserEntryIds: ["user-1", "user-2"],
		});
		expect(prepared.input.baseCheckpoint).toEqual({ id: "checkpoint-1", hash: hashEntries([base]) });
		expect(classifyPreparation(prepared, submission({ branch: checkpointBranch }))).toEqual({
			status: "current-full",
			reason: "complete",
		});
		const changed = structuredClone(checkpointBranch);
		const previous = changed[2];
		if (previous.type !== "compaction") throw new Error("Missing synthetic checkpoint");
		previous.summary = "Changed synthetic checkpoint state.";
		expect(classifyPreparation(prepared, submission({ branch: changed }))).toEqual({
			status: "invalid",
			reason: "base-checkpoint-changed",
		});
		const appended = [...checkpointBranch, { ...base, id: "checkpoint-2", parentId: "user-2" }];
		expect(classifyPreparation(prepared, submission({ branch: appended }))).toEqual({
			status: "invalid",
			reason: "base-checkpoint-changed",
		});
		expect(() => freezePreparationInput(input({ branch: checkpointBranch }))).toThrow(/CONTEXT_PREPARATION_INPUT/);
	});
});
