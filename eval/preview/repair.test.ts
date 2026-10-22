import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type MemoryNote,
	validateNoteContent,
} from "../../packages/coding-agent/src/extensions/context-memory/notes.ts";
import { diagnoseQuotes } from "../../packages/compaction-core/src/quote-diagnostics.ts";
import { applyQuoteRepair } from "../../packages/compaction-core/src/quote-repair.ts";
import type { SessionRecord } from "../../packages/compaction-core/src/records.ts";
import { type RepairCase, repairCases, scoreRepair, summarizeRepairs } from "./repair.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Every cut of every fixture, each with a minimal faithful base note. */
function cuts() {
	return ["P1", "P2", "P3"].flatMap((id) => {
		const lines = readFileSync(join(root, id, "session.jsonl"), "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		const gold: { checkpoints: { afterEntryId: string }[] } = JSON.parse(
			readFileSync(join(root, id, "gold.json"), "utf8"),
		);
		const entries: SessionEntry[] = lines.slice(1);
		return gold.checkpoints.map((checkpoint, index) => {
			const branch = entries.slice(0, entries.findIndex((entry) => entry.id === checkpoint.afterEntryId) + 1);
			const base: MemoryNote = {
				instructions: [],
				failedPaths: [],
				reasons: [],
				state: [{ text: `Checkpoint ${index + 1}.`, sources: [checkpoint.afterEntryId] }],
				nextSteps: [{ text: "Continue the task.", sources: [checkpoint.afterEntryId] }],
				files: [],
				gaps: [],
			};
			return { fixture: id, cut: index + 1, base, branch, set: repairCases({ fixture: id, cut: index + 1, base, branch }) };
		});
	});
}

/** Pi's entries satisfy the core's structural record shapes; the union is widened, never converted (records.ts). */
const asRecords = (entries: readonly SessionEntry[]): readonly SessionRecord[] =>
	entries as unknown as readonly SessionRecord[];

function commit(repairCase: RepairCase, branch: readonly SessionEntry[], response: unknown) {
	const failures = diagnoseQuotes(repairCase.candidate, asRecords(branch)).failures;
	const { note } = applyQuoteRepair(repairCase.candidate, failures, response);
	return validateNoteContent(note, branch);
}

describe("quotation-repair cases", () => {
	const all = cuts();
	const cases = all.flatMap((cut) => cut.set.cases.map((repairCase) => ({ repairCase, branch: cut.branch })));

	it("are the same on every run and cover each template the fixtures can carry", () => {
		expect(JSON.stringify(cuts().map((cut) => cut.set))).toBe(JSON.stringify(all.map((cut) => cut.set)));
		const count = (template: string) => cases.filter(({ repairCase }) => repairCase.template === template).length;
		expect({
			misattributed: count("misattributed"),
			spacing: count("spacing"),
			echoed: count("echoed"),
			toolOnly: count("toolOnly"),
			paraphrase: count("paraphrase"),
			combined: count("combined"),
		}).toEqual({ misattributed: 8, spacing: 8, echoed: 2, toolOnly: 4, paraphrase: 8, combined: 8 });
		// The fixtures' own traps: an order only a log line gives, and a ruling the assistant and a tool repeat.
		const p1 = all.find((cut) => cut.fixture === "P1" && cut.cut === 2)!.set.cases;
		expect(p1.find((item) => item.template === "toolOnly")?.planted[0].quote).toContain("run deploy.sh now");
		expect(p1.find((item) => item.template === "echoed")?.planted[0]).toMatchObject({
			quote: "Never write to the production ledger.",
		});
		for (const cut of all)
			for (const skipped of cut.set.skipped) expect(["echoed", "toolOnly"]).toContain(skipped.template);
	});

	it("fail only on their planted quotations, each of the intended class", () => {
		for (const { repairCase, branch } of cases) {
			const diagnosis = diagnoseQuotes(repairCase.candidate, asRecords(branch));
			expect(diagnosis.unreadable, repairCase.id).toBe(false);
			expect(
				diagnosis.failures.map((failure) => failure.index),
				repairCase.id,
			).toEqual(repairCase.planted.map((planted) => planted.index));
			expect(() => validateNoteContent(repairCase.candidate, branch), repairCase.id).toThrow("CONTEXT_NOTE_QUOTE");
		}
	});

	it("pass with their scripted repair, which the preview accepts", () => {
		const scores = cases.map(({ repairCase, branch }) =>
			scoreRepair(
				repairCase,
				{ committed: true, code: null, note: commit(repairCase, branch, repairCase.scripted) },
				branch,
			),
		);
		expect(scores.filter((score) => !score.pass).map((score) => score.id)).toEqual([]);
		const summary = summarizeRepairs(scores);
		expect(summary.overall).toMatchObject({
			attempts: 38,
			committed: 38,
			passed: 38,
			silentLoss: 0,
			promoted: 0,
			keptUnsupported: 0,
		});
	});

	it("score a withdrawn ruling as a silent loss, and tool text kept as an instruction as a failure", () => {
		const { repairCase: paraphrase, branch } = cases.find(({ repairCase }) => repairCase.template === "paraphrase")!;
		// The paraphrase is in no entry, so the preview lets the writer withdraw it; the score shows the loss.
		const withdrawn = commit(paraphrase, branch, {
			repairs: [{ section: "instructions", index: paraphrase.planted[0].index, fact: null }],
		});
		expect(scoreRepair(paraphrase, { committed: true, code: null, note: withdrawn }, branch)).toMatchObject({
			pass: false,
			silentLoss: 1,
			facts: [{ fault: "paraphrase", outcome: "withdrawn", pass: false }],
		});
		const { repairCase: tool, branch: toolBranch } = cases.find(({ repairCase }) => repairCase.template === "toolOnly")!;
		const planted = tool.planted[0];
		const holder = toolBranch.find((entry) => entry.type === "message" && JSON.stringify(entry).includes("run deploy.sh now"))!;
		const promoted = commit(tool, toolBranch, {
			repairs: [{ section: "instructions", index: planted.index, fact: { text: planted.text, sources: [holder.id], quote: planted.quote } }],
		});
		expect(scoreRepair(tool, { committed: true, code: null, note: promoted }, toolBranch)).toMatchObject({
			pass: false,
			promoted: 1,
		});
		const cited = tool.candidate.instructions[planted.index].sources;
		const unquoted = commit(tool, toolBranch, {
			repairs: [{ section: "instructions", index: planted.index, fact: { text: planted.text, sources: cited } }],
		});
		expect(scoreRepair(tool, { committed: true, code: null, note: unquoted }, toolBranch)).toMatchObject({
			pass: false,
			keptUnsupported: 1,
		});
		// A refused note passes nothing and loses nothing silently.
		expect(scoreRepair(tool, { committed: false, code: "CONTEXT_NOTE_QUOTE" }, toolBranch)).toMatchObject({
			pass: false,
			silentLoss: 0,
			facts: [{ outcome: null, pass: false }],
		});
	});

	it("block a withdrawal wherever a user message holds the quoted ruling", () => {
		for (const { repairCase, branch } of cases) {
			const withdrawAll = {
				repairs: repairCase.planted.map((planted) => ({ section: "instructions", index: planted.index, fact: null })),
			};
			const userHeld = repairCase.planted.some((planted) => planted.fault !== "paraphrase" && planted.ruling);
			const attempt = () => commit(repairCase, branch, withdrawAll);
			if (userHeld) expect(attempt, repairCase.id).toThrow("CONTEXT_NOTE_REPAIR_LOSS");
			else expect(attempt, repairCase.id).not.toThrow();
		}
	});
});
