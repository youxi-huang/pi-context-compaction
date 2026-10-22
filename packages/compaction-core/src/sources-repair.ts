// Lifted unchanged from the preview into the host-neutral core (v0.7.0 WP2 step 2); only the
// notes import moved to the core's copy.
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { type MemoryNote, noteSchema } from "./notes.ts";
import { sectionSchema } from "./quote-repair.ts";
import type { SchemaDiagnosis, UncitedFact } from "./schema-diagnostics.ts";

/** More facts without sources than this point at the whole note, not at a few omissions; the note blocks instead. */
export const SOURCES_REPAIR_MAX_FACTS = 5;

export const sourcesRepairSchema = Type.Object(
	{
		repairs: Type.Array(
			Type.Object(
				{
					section: sectionSchema,
					index: Type.Integer({ minimum: 0 }),
					sources: noteSchema.properties.state.items.properties.sources,
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: SOURCES_REPAIR_MAX_FACTS },
		),
	},
	{ additionalProperties: false },
);
type SourcesRepairResponse = Static<typeof sourcesRepairSchema>;

/** A repair runs only when facts without sources are the answer's sole fault, and few enough to ask about. */
export function sourcesRepairEligible(
	diagnosis: SchemaDiagnosis,
): diagnosis is SchemaDiagnosis & { pending: MemoryNote } {
	return (
		diagnosis.pending !== undefined &&
		diagnosis.uncited.length > 0 &&
		diagnosis.uncited.length <= SOURCES_REPAIR_MAX_FACTS
	);
}

/**
 * Asks for the IDs only. A withdrawal is not offered: the facts in question are mostly next steps, and a note that
 * drops its unfinished work to avoid citing it would commit with nothing to show for the loss.
 */
export const SOURCES_REPAIR_RULES = `Add the missing sources of a memory candidate; nothing else. Return ONLY the repairs object itself: one JSON object whose only key is repairs. The JSON Schema below describes that object and is not part of the answer:\n${JSON.stringify(sourcesRepairSchema)}\nReturn exactly one repair for each listed fact, with its section and index, and in sources the IDs of the entries that support it. The fact's text, quote and supersedes stay as they are and are not returned. For a next step, cite the user request it serves or the recorded progress it continues: the citation shows why the step remains, not that it is done. When a fact has a quote, cite an entry whose text contains it exactly. Cite only IDs that appear below; never invent one. entries names each citable entry by ID, role and opening words; requests holds user messages in full and cited holds excerpts of the entries the rest of the note cites. This is the only sources-repair attempt.`;

/** What a sources repair may cite, assembled by the writer from the compaction's own evidence. */
export interface CitableEvidence {
	requests: readonly { entryId: string; text: string }[];
	cited: readonly { entryId: string; role: string; text: string }[];
	entries: readonly string[];
}

/** The request names only the facts without sources, beside the evidence they may cite. */
export function sourcesRepairPrompt(
	note: MemoryNote,
	uncited: readonly UncitedFact[],
	evidence: CitableEvidence,
): string {
	return JSON.stringify({
		uncited: uncited.map((fact) => ({
			section: fact.section,
			index: fact.index,
			fact: note[fact.section][fact.index],
		})),
		...evidence,
	});
}

/**
 * Splice the writer's sources into the candidate. Every other part of the note stays byte for byte, the repaired
 * facts' text, quote and supersedes included; the caller validates the whole result again, so an ID the evidence
 * does not hold, or a quote the cited entries do not contain, still blocks.
 */
export function applySourcesRepair(note: MemoryNote, uncited: readonly UncitedFact[], response: unknown): MemoryNote {
	if (!Check(sourcesRepairSchema, response))
		throw new Error("CONTEXT_NOTE_INVALID: the sources repair did not return its schema");
	const repairs: SourcesRepairResponse["repairs"] = response.repairs;
	const key = (item: { section: string; index: number }) => `${item.section}:${item.index}`;
	const wanted = new Set(uncited.map(key));
	const given = new Set(repairs.map(key));
	if (given.size !== repairs.length || given.size !== wanted.size || [...wanted].some((item) => !given.has(item)))
		throw new Error("CONTEXT_NOTE_INVALID: the sources repair must answer each fact without sources exactly once");
	const repaired = structuredClone(note);
	for (const repair of repairs) repaired[repair.section][repair.index].sources = [...repair.sources];
	return repaired;
}
