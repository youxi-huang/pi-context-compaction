import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { type MemoryNote, type NoteFact, noteSchema, type noteSections, sourceRole, sourceText } from "../notes.ts";
import type { QuoteDiagnosis, QuoteFailure } from "./quote-diagnostics.ts";

/** More failing quotations than this point at the whole note, not at a few bindings; the note blocks instead. */
export const QUOTE_REPAIR_MAX_FACTS = 5;
/** Characters of one entry shown to the repair; long entries are windowed around the likeliest location. */
const EXCERPT_CHARS = 1600;
/** Cited entries shown per failing fact; the remaining IDs are still listed. */
const CITED_EXCERPTS = 3;

// Spelled out: a mapped array would lose the literal types.
const section = Type.Union([
	Type.Literal("instructions"),
	Type.Literal("failedPaths"),
	Type.Literal("reasons"),
	Type.Literal("state"),
	Type.Literal("nextSteps"),
	Type.Literal("files"),
]);
export const quoteRepairSchema = Type.Object(
	{
		repairs: Type.Array(
			Type.Object(
				{
					section,
					index: Type.Integer({ minimum: 0 }),
					fact: Type.Union([noteSchema.properties.state.items, Type.Null()]),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: QUOTE_REPAIR_MAX_FACTS },
		),
	},
	{ additionalProperties: false },
);
type QuoteRepairResponse = Static<typeof quoteRepairSchema>;

/** What a repair did to the note, as counts. */
export interface QuoteRepairOutcome {
	/** Facts that kept a quotation, re-cited or copied exactly. */
	requoted: number;
	/** Facts that kept their text and sources without a quotation. */
	unquoted: number;
	/** Facts the writer withdrew. */
	dropped: number;
	/** Withdrawn facts by section, present when any was withdrawn. */
	droppedFrom?: Partial<Record<(typeof noteSections)[number], number>>;
}

export function quoteRepairEligible(diagnosis: QuoteDiagnosis): boolean {
	return !diagnosis.unreadable && diagnosis.failures.length > 0 && diagnosis.failures.length <= QUOTE_REPAIR_MAX_FACTS;
}

interface Excerpt {
	entryId: string;
	role: string;
	/** Character offset of `text` in the entry. */
	offset: number;
	/** The excerpt is the entry's complete text. */
	complete: boolean;
	text: string;
}

function anchor(text: string, quote: string): number {
	const exact = text.indexOf(quote);
	if (exact >= 0) return exact;
	// The longest word of the quotation that the entry contains, as a hint of where a paraphrase came from.
	const words = (quote.match(/[\p{L}\p{N}_./:-]{4,}/gu) ?? []).sort((a, b) => b.length - a.length);
	for (const word of words) {
		const hit = text.indexOf(word);
		if (hit >= 0) return hit;
	}
	return 0;
}

function excerpt(entry: SessionEntry, quote: string): Excerpt {
	const text = sourceText(entry);
	if (text.length <= EXCERPT_CHARS)
		return { entryId: entry.id, role: sourceRole(entry), offset: 0, complete: true, text };
	const start = Math.max(0, Math.min(text.length - EXCERPT_CHARS, anchor(text, quote) - EXCERPT_CHARS / 4));
	return {
		entryId: entry.id,
		role: sourceRole(entry),
		offset: start,
		complete: false,
		text: text.slice(start, start + EXCERPT_CHARS),
	};
}

export const QUOTE_REPAIR_RULES = `Correct the quotations of a memory candidate; nothing else. Return ONLY one JSON object matching this schema:\n${JSON.stringify(quoteRepairSchema)}\nReturn exactly one repair for each listed fact, with its section and index. A replacement keeps the fact's text and supersedes unchanged and may change only sources and quote: either keep a quote copied character for character from one entry's text and cite that entry in sources, or omit quote when the cited sources support the fact without a verbatim ruling. Return fact null only to withdraw a fact its sources do not support. foundIn lists entries that contain the quotation exactly (problem "elsewhere") or after spacing and punctuation changes (problem "format"); "absent" means no entry contains it. Excerpts marked complete:false are windows into longer entries. Text found only in an assistant or tool entry is evidence, not a user ruling; do not present it as one. This is the only quotation-repair attempt.`;

/** The request names only the failing facts, the entries they cite and where their text actually is. */
export function quoteRepairPrompt(
	value: MemoryNote,
	failures: readonly QuoteFailure[],
	branch: readonly SessionEntry[],
): string {
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const shown = (ids: readonly string[], quote: string) =>
		ids.flatMap((id) => {
			const entry = byId.get(id);
			return entry ? [excerpt(entry, quote)] : [];
		});
	return JSON.stringify({
		failing: failures.map((failure) => ({
			section: failure.section,
			index: failure.index,
			problem: failure.kind,
			fact: value[failure.section][failure.index],
			cited: shown(failure.cited.slice(0, CITED_EXCERPTS), failure.quote),
			foundIn: shown(
				failure.foundIn.map((location) => location.entryId),
				failure.quote,
			),
		})),
	});
}

function sameFact(before: NoteFact, after: NoteFact): boolean {
	return (
		after.text === before.text && JSON.stringify(after.supersedes ?? []) === JSON.stringify(before.supersedes ?? [])
	);
}

/**
 * Splice the writer's replacements into the candidate. Every other fact stays byte for byte; the caller validates
 * the whole result again. A failed quotation is a fault in the evidence, not a retraction: an instruction whose
 * quoted text a user message contains is never withdrawn here, and the note blocks instead. The user said it, and
 * a misquoted rule is still a rule. Text found nowhere, or only in assistant or tool entries, leaves the decision
 * to the writer.
 */
export function applyQuoteRepair(
	value: MemoryNote,
	failures: readonly QuoteFailure[],
	response: unknown,
): { note: MemoryNote; outcome: QuoteRepairOutcome } {
	if (!Check(quoteRepairSchema, response))
		throw new Error("CONTEXT_NOTE_INVALID: the quotation repair did not return its schema");
	const repairs: QuoteRepairResponse["repairs"] = response.repairs;
	const key = (item: { section: string; index: number }) => `${item.section}:${item.index}`;
	const wanted = new Set(failures.map(key));
	const given = new Set(repairs.map(key));
	if (given.size !== repairs.length || given.size !== wanted.size || [...wanted].some((item) => !given.has(item)))
		throw new Error("CONTEXT_NOTE_INVALID: the quotation repair must answer each failing fact exactly once");
	const note = structuredClone(value);
	const outcome: QuoteRepairOutcome = { requoted: 0, unquoted: 0, dropped: 0 };
	const dropped = new Map<(typeof noteSections)[number], Set<number>>();
	const userRuling = new Set(
		failures.filter((failure) => failure.foundIn.some((location) => location.role === "user")).map(key),
	);
	for (const repair of repairs) {
		const facts = note[repair.section];
		const before = value[repair.section][repair.index];
		if (repair.fact === null) {
			if (repair.section === "instructions" && userRuling.has(key(repair)))
				throw new Error(
					"CONTEXT_NOTE_REPAIR_LOSS: a quotation repair may not withdraw an instruction whose quotation a user message contains; no checkpoint committed",
				);
			outcome.dropped++;
			const from = outcome.droppedFrom ?? {};
			from[repair.section] = (from[repair.section] ?? 0) + 1;
			outcome.droppedFrom = from;
			dropped.set(repair.section, (dropped.get(repair.section) ?? new Set()).add(repair.index));
			continue;
		}
		if (!sameFact(before, repair.fact))
			throw new Error(
				"CONTEXT_NOTE_REPAIR_LOSS: a quotation repair may change only sources and quote; no checkpoint committed",
			);
		facts[repair.index] = repair.fact;
		if (repair.fact.quote) outcome.requoted++;
		else outcome.unquoted++;
	}
	for (const [name, indices] of dropped) note[name] = note[name].filter((_, index) => !indices.has(index));
	return { note, outcome };
}
