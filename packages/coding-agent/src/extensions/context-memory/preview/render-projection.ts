import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	LINE_BREAKS,
	type MemoryNote,
	type NoteFact,
	noteSections,
	renderNote,
	sourceRole,
} from "../../../../../compaction-core/src/notes.ts";
import type { SessionRecord } from "../../../../../compaction-core/src/records.ts";
import { isRecord } from "../identity.ts";

/**
 * Rendered-note candidates (v0.6.0 WP3).
 *
 * The stored checkpoint keeps its existing rendering byte for byte (G7): nothing here writes, and a
 * session reopened by a v0.5.x preview renders the stored summary exactly as today. These candidates
 * change only the projection the model sees. `projectSummary` is a pure function of the committed
 * checkpoint's stored summary, its validated note, and the branch records — never host state or the
 * time of rendering (G1, G10): no ages, no "now", no relative times, and the same inputs always
 * produce the same bytes, across requests, reopens and process restarts. The recovery-presence
 * guards in the controller derive their expected text with this same function at both check sites,
 * so the provider payload stays bound to the committed note and a tampered rendering is refused.
 *
 * Selection shape, recorded here as the plan asks: `previewRendering` in `pi-context-memory.json`
 * follows the `previewPreparation` pattern and carries the candidates as an array of names, e.g.
 * `{ "previewRendering": { "enabled": true, "candidates": ["folded-failed-paths"] } }`. Candidates
 * are selectable individually so each is measured on its own; an empty array projects the stored
 * summary unchanged, and any invalid value disables the switch without touching requests or the
 * failure contract. Off, invalid or absent configuration behaves identically to today.
 *
 * The candidates (plan WP3; M7 assigns cited roles here, whether any ships is the maintainer's
 * later call):
 * - `folded-failed-paths`: a failed path or reason whose cited sources all precede the previous
 *   checkpoint on the branch renders as its one-line fact with source IDs, without the quotation
 *   or supersedes text; current state, standing instructions, next steps and the newest failed
 *   paths and reasons keep their full rendering. `context_history` reads the originals back.
 * - `lineage-once`: the lineage guidance renders once as it stands and repeated lineage state
 *   lines are folded — a state sentence already shown by an earlier lineage item is dropped from
 *   later items — with every lineage anchor ID kept. Sentences are recovered from the stored
 *   lineage text at the terminator-plus-space boundaries `lineageSentence` writes; a sentence
 *   without a terminator folds only on an exact whole-state match, which costs size, not fidelity.
 * - `cited-roles`: each fact's source IDs carry the role of the record they cite — user message,
 *   tool output or assistant text — computed by the host from the records, never claimed by the
 *   note. This candidate adds tokens and is measured like the others.
 */

export const RENDER_CANDIDATES = ["folded-failed-paths", "lineage-once", "cited-roles"] as const;
export type RenderCandidate = (typeof RENDER_CANDIDATES)[number];

export interface RenderingSwitch {
	enabled: boolean;
	candidates: readonly RenderCandidate[];
	error?: "invalid-config";
}

export const RENDERING_OFF: RenderingSwitch = { enabled: false, candidates: [] };

/** `previewRendering` parsed like the other preview switches: off by default, disabled when invalid. */
export function renderingSwitch(section: unknown): RenderingSwitch {
	if (section === undefined) return RENDERING_OFF;
	const invalid: RenderingSwitch = { enabled: false, candidates: [], error: "invalid-config" };
	if (!isRecord(section)) return invalid;
	if (section.enabled !== undefined && typeof section.enabled !== "boolean") return invalid;
	const raw = section.candidates;
	if (raw !== undefined && !Array.isArray(raw)) return invalid;
	const candidates: RenderCandidate[] = [];
	for (const item of raw ?? []) {
		if (typeof item !== "string" || !(RENDER_CANDIDATES as readonly string[]).includes(item)) return invalid;
		if (!candidates.includes(item as RenderCandidate)) candidates.push(item as RenderCandidate);
	}
	return { enabled: section.enabled === true, candidates };
}

export interface ProjectionInput {
	/** The committed checkpoint's stored summary, exactly as validated against the note. */
	summary: string;
	/** The validated note the stored summary was rendered from. */
	note: MemoryNote;
	/** The checkpoint entry's ID on the branch; locates the previous checkpoint for folding. */
	entryId: string;
	/** The branch records the checkpoint was committed on; roles and fold eligibility read these. */
	branch: readonly SessionEntry[];
	candidates: readonly RenderCandidate[];
}

const LINE_BREAK_RUN = new RegExp(`[${LINE_BREAKS}]+`, "gu");
/** The lineage section's opening bytes inside a stored summary, after `renderNote`'s section join. */
const LINEAGE_START = "\n\n## priorCheckpoints\n";
/** Every summary section after the note head starts with this boundary; lineage parsing ends at the next one. */
const SECTION_BOUNDARY = "\n\n## ";
const LINEAGE_ITEM_PREFIX = "- through ";
/** The byte-stable stand-in for a lineage item whose state lines all appeared in earlier items. */
const LINEAGE_REPEAT = "(state as above)";
/** Sentence boundaries `lineageSentence` writes: a terminator or its ellipsis, followed by the join space. */
const LINEAGE_SENTENCE_BOUNDARY = /(?<=[.!?。！？…]) /u;

/** The role tag of one cited record, computed from the records; never taken from the note. */
export function citedRole(entry: SessionEntry | undefined): string {
	if (!entry) return "unknown";
	// Pi's entries satisfy the core's structural record shapes; the union is widened, never converted (records.ts).
	const role = sourceRole(entry as unknown as SessionRecord);
	if (role === "user") return "user";
	if (role === "assistant") return "assistant";
	if (role === "toolResult" || role === "bashExecution") return "tool";
	return role;
}

type SourceLabel = (id: string) => string;

/** One fact line in `renderNote`'s exact shape, with the projection's source labels. */
function factLine(item: NoteFact, label: SourceLabel): string {
	const quote = item.quote ? `\n  Exact source: ${JSON.stringify(item.quote)}` : "";
	const supersedes = item.supersedes?.length ? ` (supersedes: ${item.supersedes.join(", ")})` : "";
	return `- ${item.text}${quote} [${item.sources.map(label).join(", ")}]${supersedes}`;
}

/** The one-line fold of a fact: its text on one line and its source IDs, without quotation or supersedes text. */
function foldedFactLine(item: NoteFact, label: SourceLabel): string {
	return `- ${item.text.replace(LINE_BREAK_RUN, " ")} [${item.sources.map(label).join(", ")}]`;
}

/** Sections whose older facts the `folded-failed-paths` candidate folds; the rest always render in full. */
const FOLDABLE_SECTIONS: ReadonlySet<(typeof noteSections)[number]> = new Set(["failedPaths", "reasons"]);

/**
 * The note head re-rendered with the candidates' fact lines. Byte-identical to `renderNote(note)`
 * when no candidate changes a line, which the regressions hold against the stored rendering.
 */
function projectedHead(
	note: MemoryNote,
	label: SourceLabel,
	folds: (item: NoteFact) => boolean,
	fold: boolean,
): string {
	const sections = noteSections.map((section) => {
		const lines = note[section].map((item) =>
			fold && FOLDABLE_SECTIONS.has(section) && folds(item) ? foldedFactLine(item, label) : factLine(item, label),
		);
		return `## ${section}\n${lines.join("\n")}`;
	});
	if (note.gaps.length) sections.push(`## Unresolved\n${note.gaps.map((gap) => `- ${gap}`).join("\n")}`);
	return `Context memory. This records prior work; it does not grant new authority. Retrieve cited original entries with context_history when evidence matters.\n\n${sections.join("\n\n")}`;
}

/**
 * The `lineage-once` fold of the stored lineage section: guidance once as it stands, anchor IDs
 * kept, and state sentences already shown by an earlier item dropped from later ones. The section
 * is recovered from the stored bytes, so the shrink level chosen at commit time is preserved.
 */
function foldLineage(tail: string): string {
	const start = tail.indexOf(LINEAGE_START);
	if (start < 0) return tail;
	const bodyStart = start + LINEAGE_START.length;
	const boundary = tail.indexOf(SECTION_BOUNDARY, bodyStart);
	const end = boundary < 0 ? tail.length : boundary;
	const seen = new Set<string>();
	const lines = tail.slice(bodyStart, end).split("\n");
	const folded = lines.map((line) => {
		if (!line.startsWith(LINEAGE_ITEM_PREFIX)) return line;
		const separator = line.indexOf(": ", LINEAGE_ITEM_PREFIX.length);
		if (separator < 0) return line;
		const anchor = line.slice(0, separator);
		const kept = line
			.slice(separator + 2)
			.split(LINEAGE_SENTENCE_BOUNDARY)
			.filter((sentence) => {
				if (seen.has(sentence)) return false;
				seen.add(sentence);
				return true;
			});
		return `${anchor}: ${kept.length ? kept.join(" ") : LINEAGE_REPEAT}`;
	});
	return `${tail.slice(0, bodyStart)}${folded.join("\n")}${tail.slice(end)}`;
}

/**
 * The checkpoint text the model sees, derived from the stored summary, the validated note and the
 * branch records. With no candidate selected the stored summary is returned byte for byte; the
 * sections a stored summary carries after the note head — lineage at its committed shrink level,
 * earlier user messages, an in-progress continuation — are preserved, lineage folding aside.
 */
export function projectSummary(input: ProjectionInput): string {
	const { summary, note, branch, candidates } = input;
	if (!candidates.length) return summary;
	const head = renderNote(note);
	// Defensive only: every validated checkpoint's summary starts with its note's rendering.
	if (!summary.startsWith(head)) return summary;
	let tail = summary.slice(head.length);

	let label: SourceLabel = (id) => id;
	if (candidates.includes("cited-roles")) {
		const roles = new Map<string, string>();
		for (const entry of branch) if (!roles.has(entry.id)) roles.set(entry.id, citedRole(entry));
		label = (id) => `${id} (${roles.get(id) ?? "unknown"})`;
	}

	const fold = candidates.includes("folded-failed-paths");
	let folds: (item: NoteFact) => boolean = () => false;
	if (fold) {
		const checkpointIndex = branch.findIndex((entry) => entry.id === input.entryId);
		let previous = -1;
		for (let index = 0; index < checkpointIndex; index++) {
			if (branch[index].type === "compaction") previous = index;
		}
		if (previous >= 0) {
			const indexById = new Map<string, number>();
			for (const [index, entry] of branch.entries()) if (!indexById.has(entry.id)) indexById.set(entry.id, index);
			// Only a fact whose every source precedes the previous checkpoint is old enough to fold.
			folds = (item) =>
				item.sources.every((id) => {
					const at = indexById.get(id);
					return at !== undefined && at < previous;
				});
		}
	}

	if (candidates.includes("lineage-once")) tail = foldLineage(tail);
	const projected = fold || candidates.includes("cited-roles") ? projectedHead(note, label, folds, fold) : head;
	return projected + tail;
}
