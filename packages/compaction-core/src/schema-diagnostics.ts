// Lifted unchanged from the preview into the host-neutral core (v0.7.0 WP2 step 2); only the
// identity and notes imports moved to the core's copies.
import { Check } from "typebox/value";
import { isRecord } from "./identity.ts";
import { type MemoryNote, noteSchema, noteSections } from "./notes.ts";

export type NoteSection = (typeof noteSections)[number];

/** A fact the writer returned without sources, or with an empty list of them. */
export interface UncitedFact {
	section: NoteSection;
	index: number;
}

export interface SchemaDiagnosis {
	uncited: UncitedFact[];
	/** The answer fails the schema for another reason too: a missing section, an unknown key, a wrong type or a limit. */
	other: boolean;
	/** When the missing sources are the only fault: the answer as a note, those facts' sources left empty. */
	pending?: MemoryNote;
}

/** Content-free counts, safe for status output and error messages. */
export interface SchemaCounts {
	/** Facts without sources, by section. */
	uncited: Partial<Record<NoteSection, number>>;
	other: boolean;
}

/** Stands in for the missing sources while the rest of the answer is checked, then removed; never stored or sent. */
const PLACEHOLDER = "uncited";

/**
 * Why a parsed answer fails the note schema, where the validator only says that it does. A fact counts as uncited
 * when `sources` is absent or empty; the answer is then checked again with a placeholder in those places, so
 * `other` is false exactly when the missing sources are the only fault. Acceptance stays with `validateNote`.
 */
export function diagnoseSchema(value: unknown): SchemaDiagnosis {
	const uncited: UncitedFact[] = [];
	if (!isRecord(value)) return { uncited, other: true };
	const patched: Record<string, unknown> = { ...value };
	for (const section of noteSections) {
		const items = value[section];
		if (!Array.isArray(items)) continue;
		patched[section] = items.map((item: unknown, index) => {
			if (!isRecord(item) || !(item.sources === undefined || (Array.isArray(item.sources) && !item.sources.length)))
				return item;
			uncited.push({ section, index });
			return { ...item, sources: [PLACEHOLDER] };
		});
	}
	if (!Check(noteSchema, patched)) return { uncited, other: true };
	for (const fact of uncited) patched[fact.section][fact.index].sources = [];
	return { uncited, other: false, pending: patched };
}

export function schemaCounts(diagnosis: SchemaDiagnosis): SchemaCounts {
	const uncited: SchemaCounts["uncited"] = {};
	for (const fact of diagnosis.uncited) uncited[fact.section] = (uncited[fact.section] ?? 0) + 1;
	return { uncited, other: diagnosis.other };
}

/** The validator's code with counts per section; never the facts' text. */
export function schemaFailureMessage(counts: SchemaCounts): string {
	const sections = Object.entries(counts.uncited).map(([section, count]) => `${count} in ${section}`);
	const total = Object.values(counts.uncited).reduce((sum, count) => sum + count, 0);
	const reason = total
		? `${total} fact${total === 1 ? " has" : "s have"} no sources (${sections.join(", ")})${counts.other ? ", and the note fails the schema otherwise too" : ""}`
		: "writer must return the complete note schema";
	return `CONTEXT_NOTE_INVALID: ${reason}. No checkpoint committed; original history retained.`;
}
