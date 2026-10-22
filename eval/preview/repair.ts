import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type MemoryNote,
	type NoteFact,
	sourceRole,
	sourceText,
} from "../../packages/coding-agent/src/extensions/context-memory/notes.ts";
import {
	diagnoseQuotes,
	normalizeQuote,
	type QuoteFailureKind,
} from "../../packages/compaction-core/src/quote-diagnostics.ts";
import type { SessionRecord } from "../../packages/compaction-core/src/records.ts";

// Quotation-repair cases for the preview's one repair, planted in the P fixtures (0.5.1).
//
// A case is a faithful note for a fixture cut with one to three instructions whose quotations fail in a known
// way. The writer bench answers the first writer call with the case's candidate and lets the measured model
// answer only the repair, so every repair sees the same request a session would send, and its outcome can be
// scored without a judge: the committed note either still carries the user's ruling or it does not.

/** Change it whenever the cases or their scoring change, so runs compare only within one version. */
export const REPAIR_CASES_VERSION = "0.5.1-repair-cases.1";

/**
 * `misattributed` cites a user ruling to another user entry; `spacing` doubles a space in an exact ruling;
 * `echoed` cites a ruling the assistant and a tool repeated to the wrong user entry; `toolOnly` records text only
 * a tool or the assistant wrote as a user instruction; `paraphrase` quotes a ruling in other words. `combined`
 * plants a misattribution, a spacing fault and a paraphrase in one note.
 */
export const REPAIR_TEMPLATES = ["misattributed", "spacing", "echoed", "toolOnly", "paraphrase", "combined"] as const;
export type RepairTemplate = (typeof REPAIR_TEMPLATES)[number];
export type RepairFault = Exclude<RepairTemplate, "combined">;

const EXPECTED_CLASS: Record<RepairFault, QuoteFailureKind> = {
	misattributed: "elsewhere",
	spacing: "format",
	echoed: "elsewhere",
	toolOnly: "elsewhere",
	paraphrase: "absent",
};

/** One planted instruction. Its text is the ruling's own words, which a repair may not change. */
export interface PlantedFact {
	fault: RepairFault;
	/** Position in the candidate's `instructions`. */
	index: number;
	text: string;
	quote: string;
	/** The user entry that holds the ruling verbatim; absent when no user said it. */
	ruling?: string;
}

export interface RepairCase {
	id: string;
	template: RepairTemplate;
	candidate: MemoryNote;
	planted: PlantedFact[];
	/** A correct repair. The loopback writer returns it, so the harness and the scoring check each other. */
	scripted: { repairs: { section: "instructions"; index: number; fact: NoteFact | null }[] };
}

export interface RepairCaseSet {
	cases: RepairCase[];
	/** Templates this cut cannot carry, with the reason; reported rather than replaced. */
	skipped: { template: RepairTemplate; reason: string }[];
}

interface Span {
	entry: SessionEntry;
	role: string;
	text: string;
}

const ORDER_WORDS = /\b(must|only|never|always|do not|don't|should|deploy)\b/iu;

function rank(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/** Sentences and lines of one entry, short enough to be a quoted ruling. */
function spans(entry: SessionEntry): Span[] {
	const role = sourceRole(entry);
	return sourceText(entry)
		.split(/\n+|(?<=[.!?])\s+/u)
		.map((text) => text.trim())
		.filter((text) => text.length >= 24 && text.length <= 160)
		.map((text) => ({ entry, role, text }));
}

function paraphrases(text: string): string[] {
	const options = [
		text.replace(/\bdo not\b/u, "don't").replace(/\bDo not\b/u, "Don't"),
		text.replace(/\bdon't\b/u, "do not").replace(/\bDon't\b/u, "Do not"),
		text.replace(/ the /u, " "),
		text.replace(/[.!?]$/u, "") + " in this task.",
	];
	return [...new Set(options.filter((option) => option !== text))];
}

/**
 * The cases one fixture cut can carry. `base` is the faithful note the bench's loopback writer would commit at
 * this cut, `branch` the session's entries up to the cut. A planted fault is kept only when the preview's own
 * diagnosis classifies it as intended, so a case always fails on exactly its planted quotations.
 */
export function repairCases(input: {
	fixture: string;
	cut: number;
	base: MemoryNote;
	branch: readonly SessionEntry[];
}): RepairCaseSet {
	const { fixture, cut, base, branch } = input;
	const messages = branch.filter((entry) => entry.type === "message" && sourceText(entry).length > 0);
	const texts = messages.map((entry) => ({ entry, text: sourceText(entry) }));
	const holders = (text: string) => texts.filter((item) => item.text.includes(text)).map((item) => item.entry);
	const normalized = texts.map((item) => normalizeQuote(item.text));
	/** A wording no entry holds, even after spacing and punctuation are normalized. */
	const unheld = (text: string) => paraphrases(text).find((option) => !normalized.some((item) => item.includes(normalizeQuote(option))));
	const all = messages.flatMap(spans);
	const users = messages.filter((entry) => sourceRole(entry) === "user");
	const byRank = <T>(items: readonly T[], key: (item: T) => string, template: string) =>
		[...items].sort((a, b) => (rank(fixture, String(cut), template, key(a)) < rank(fixture, String(cut), template, key(b)) ? -1 : 1));
	const spanKey = (span: Span) => `${span.entry.id}\u0000${span.text}`;
	const used = new Set<string>();
	const unique = all.filter((span) => span.role === "user" && holders(span.text).length === 1);
	const echoed = all.filter((span) => {
		if (span.role !== "user") return false;
		const roles = new Set(holders(span.text).map(sourceRole));
		return roles.has("assistant") || roles.has("toolResult");
	});
	const toolOnly = all.filter(
		(span) =>
			(span.role === "toolResult" || span.role === "assistant") &&
			!holders(span.text).some((entry) => sourceRole(entry) === "user"),
	);
	/**
	 * An entry that does not hold the text, to cite by mistake: another user entry, or for a user's ruling the
	 * assistant's when the cut has no other user entry.
	 */
	const elsewhere = (span: Span, template: string) => {
		const without = (entry: SessionEntry) => entry.id !== span.entry.id && !sourceText(entry).includes(span.text);
		const others = users.filter(without);
		const pool = others.length || span.role !== "user" ? others : messages.filter((entry) => sourceRole(entry) === "assistant" && without(entry));
		return byRank(pool, (entry) => entry.id, `${template}:cite:${span.text}`)[0];
	};
	const pick = (pool: readonly Span[], template: string, accept: (span: Span) => boolean = () => true) =>
		byRank(
			pool.filter((span) => !used.has(span.text) && accept(span)),
			spanKey,
			template,
		)[0];

	type Plant = Omit<PlantedFact, "index"> & { sources: string[]; repair: NoteFact | null };
	const plant = (fault: RepairFault, template: string): Plant | string => {
		if (fault === "misattributed" || fault === "echoed") {
			const span = pick(fault === "echoed" ? echoed : unique, template, (item) => !!elsewhere(item, template));
			if (!span) return `no ${fault === "echoed" ? "echoed" : "unique"} user sentence with another entry to cite`;
			used.add(span.text);
			return {
				fault,
				text: span.text,
				quote: span.text,
				ruling: span.entry.id,
				sources: [elsewhere(span, template)!.id],
				repair: { text: span.text, sources: [span.entry.id], quote: span.text },
			};
		}
		if (fault === "spacing") {
			const span = pick(unique, template, (item) => item.text.includes(" "));
			if (!span) return "no unique user sentence";
			used.add(span.text);
			return {
				fault,
				text: span.text,
				quote: span.text.replace(" ", "  "),
				ruling: span.entry.id,
				sources: [span.entry.id],
				repair: { text: span.text, sources: [span.entry.id], quote: span.text },
			};
		}
		if (fault === "paraphrase") {
			const span = pick(unique, template, (item) => unheld(item.text) !== undefined);
			if (!span) return "no unique user sentence";
			used.add(span.text);
			return {
				fault,
				text: span.text,
				quote: unheld(span.text)!,
				ruling: span.entry.id,
				sources: [span.entry.id],
				repair: { text: span.text, sources: [span.entry.id] },
			};
		}
		// Only text that reads as an order: a log line no one would take for a ruling tests nothing.
		const span = pick(toolOnly, template, (item) => ORDER_WORDS.test(item.text) && !!elsewhere(item, template));
		if (!span) return "no order that only a tool or the assistant wrote";
		used.add(span.text);
		return { fault, text: span.text, quote: span.text, sources: [elsewhere(span, template)!.id], repair: null };
	};

	const cases: RepairCase[] = [];
	const skipped: RepairCaseSet["skipped"] = [];
	for (const template of REPAIR_TEMPLATES) {
		// Each template chooses on its own; within `combined` the three faults take different sentences.
		used.clear();
		const faults: RepairFault[] =
			template === "combined" ? ["misattributed", "spacing", "paraphrase"] : [template];
		const plants: Plant[] = [];
		let reason: string | undefined;
		for (const fault of faults) {
			const result = plant(fault, template);
			if (typeof result === "string") {
				reason = result;
				break;
			}
			plants.push(result);
		}
		if (reason) {
			skipped.push({ template, reason });
			continue;
		}
		const offset = base.instructions.length;
		const candidate: MemoryNote = structuredClone(base);
		candidate.instructions.push(
			...plants.map((item) => ({ text: item.text, sources: item.sources, quote: item.quote })),
		);
		const planted: PlantedFact[] = plants.map((item, index) => ({
			fault: item.fault,
			index: offset + index,
			text: item.text,
			quote: item.quote,
			...(item.ruling ? { ruling: item.ruling } : {}),
		}));
		// Pi's entries satisfy the core's structural record shapes; the union is widened, never converted (records.ts).
		const diagnosis = diagnoseQuotes(candidate, branch as unknown as readonly SessionRecord[]);
		const classes = diagnosis.failures.map((failure) => `${failure.section}:${failure.index}:${failure.kind}`);
		const wanted = planted.map((item) => `instructions:${item.index}:${EXPECTED_CLASS[item.fault]}`);
		if (diagnosis.unreadable || JSON.stringify(classes) !== JSON.stringify(wanted)) {
			skipped.push({ template, reason: `planted faults diagnose as ${classes.join(", ") || "none"}` });
			continue;
		}
		cases.push({
			id: `${fixture}-cut${cut}-${template}`,
			template,
			candidate,
			planted,
			scripted: {
				repairs: plants.map((item, index) => ({ section: "instructions", index: offset + index, fact: item.repair })),
			},
		});
	}
	return { cases, skipped };
}

/** What became of a planted instruction in the committed note. */
export type PlantedOutcome = "requotedUser" | "requotedOther" | "unquoted" | "withdrawn";

export interface RepairScore {
	id: string;
	template: RepairTemplate;
	committed: boolean;
	code: string | null;
	facts: { fault: RepairFault; outcome: PlantedOutcome | null; pass: boolean }[];
	pass: boolean;
	/** Committed without a ruling a user gave. */
	silentLoss: number;
	/** Committed with an instruction quoted only from assistant or tool text. */
	promoted: number;
	/** Committed with an instruction no user gave, kept without a quotation. */
	keptUnsupported: number;
}

/**
 * Score one attempt. A ruling a user gave passes when the note keeps it, quoted from a user entry or unquoted; text
 * no user gave passes only when the repair withdrew it. A refused note passes nothing, and is not a silent loss.
 */
export function scoreRepair(
	repairCase: RepairCase,
	result: { committed: boolean; code: string | null; note?: MemoryNote },
	branch: readonly SessionEntry[],
): RepairScore {
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const remaining = result.committed && result.note ? [...result.note.instructions] : [];
	const facts = repairCase.planted.map((planted) => {
		if (!result.committed) return { fault: planted.fault, outcome: null, pass: false };
		const at = remaining.findIndex((fact) => fact.text === planted.text);
		let outcome: PlantedOutcome = "withdrawn";
		if (at >= 0) {
			const [fact] = remaining.splice(at, 1);
			const quote = fact.quote;
			outcome = !quote
				? "unquoted"
				: fact.sources.some((id) => {
							const entry = byId.get(id);
							return !!entry && sourceRole(entry) === "user" && sourceText(entry).includes(quote);
						})
					? "requotedUser"
					: "requotedOther";
		}
		const pass = planted.ruling
			? outcome === "requotedUser" || outcome === "unquoted"
			: outcome === "withdrawn";
		return { fault: planted.fault, outcome, pass };
	});
	return {
		id: repairCase.id,
		template: repairCase.template,
		committed: result.committed,
		code: result.code,
		facts,
		pass: result.committed && facts.every((fact) => fact.pass),
		silentLoss: repairCase.planted.filter((planted, index) => planted.ruling && facts[index].outcome === "withdrawn")
			.length,
		promoted: facts.filter((fact) => fact.outcome === "requotedOther").length,
		keptUnsupported: repairCase.planted.filter(
			(planted, index) => !planted.ruling && facts[index].outcome === "unquoted",
		).length,
	};
}

/** Totals with denominators, overall and by template. */
export function summarizeRepairs(scores: readonly RepairScore[]) {
	const tally = (list: readonly RepairScore[]) => {
		const codes: Record<string, number> = {};
		const outcomes: Record<string, number> = {};
		for (const score of list) {
			if (!score.committed) codes[score.code ?? "UNKNOWN"] = (codes[score.code ?? "UNKNOWN"] ?? 0) + 1;
			for (const fact of score.facts) {
				const key = `${fact.fault}:${fact.outcome ?? "refused"}`;
				outcomes[key] = (outcomes[key] ?? 0) + 1;
			}
		}
		return {
			attempts: list.length,
			committed: list.filter((score) => score.committed).length,
			passed: list.filter((score) => score.pass).length,
			silentLoss: list.reduce((sum, score) => sum + score.silentLoss, 0),
			promoted: list.reduce((sum, score) => sum + score.promoted, 0),
			keptUnsupported: list.reduce((sum, score) => sum + score.keptUnsupported, 0),
			refusedByCode: codes,
			outcomes,
		};
	};
	return {
		version: REPAIR_CASES_VERSION,
		overall: tally(scores),
		byTemplate: Object.fromEntries(
			REPAIR_TEMPLATES.map((template) => [template, tally(scores.filter((score) => score.template === template))]),
		),
	};
}
