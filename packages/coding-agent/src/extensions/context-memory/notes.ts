import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { CompactionEntry, SessionEntry } from "../../core/session-manager.ts";
import { textTokens } from "./config.ts";
import { CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION, CONTEXT_NOTE_TYPE, hashEntries, isRecord } from "./identity.ts";

export { hashEntries } from "./identity.ts";

const fact = Type.Object(
	{
		text: Type.String({ minLength: 1, maxLength: 4000 }),
		sources: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
			minItems: 1,
			maxItems: 20,
			uniqueItems: true,
		}),
		quote: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
		supersedes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 20 })),
	},
	{ additionalProperties: false },
);
const facts = Type.Array(fact, { maxItems: 40 });

export const noteSchema = Type.Object(
	{
		instructions: facts,
		failedPaths: facts,
		reasons: facts,
		state: Type.Array(fact, { minItems: 1, maxItems: 40 }),
		nextSteps: Type.Array(fact, { maxItems: 5 }),
		files: facts,
		gaps: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 }),
	},
	{ additionalProperties: false },
);
export type MemoryNote = Static<typeof noteSchema>;
export type NoteFact = Static<typeof fact>;
export const noteSections = ["instructions", "failedPaths", "reasons", "state", "nextSteps", "files"] as const;

export interface SourceSnapshot {
	sessionId: string;
	leafId: string | null;
	lastCheckpointId: string | null;
}

export interface MemoryCheckpoint {
	kind: typeof CONTEXT_MEMORY_KIND;
	version: typeof CONTEXT_MEMORY_VERSION;
	note: MemoryNote;
	coveredThrough: string;
	sourceHash: string;
	snapshot: SourceSnapshot;
	writerModel: string;
	chunkCount: number;
	build: string;
}

export function sourceText(entry: SessionEntry): string {
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "bashExecution")
			return JSON.stringify({
				command: message.command,
				output: message.output,
				exitCode: message.exitCode,
				fullOutputPath: message.fullOutputPath,
			});
		if ("content" in message) {
			if (typeof message.content === "string") return message.content;
			return (message.content ?? [])
				.map((block) => {
					if (block.type === "text") return block.text;
					if (block.type === "toolCall") return JSON.stringify({ tool: block.name, arguments: block.arguments });
					return `[${block.type} content retained in original session; not inferred in text notes]`;
				})
				.join("\n");
		}
	}
	if (entry.type === "custom_message")
		return typeof entry.content === "string"
			? entry.content
			: entry.content
					.map((part) => (part.type === "text" ? part.text : "[image retained in original session]"))
					.join("\n");
	if (entry.type === "branch_summary") return entry.summary;
	return "";
}

export function sourceRole(entry: SessionEntry): string {
	return entry.type === "message" ? entry.message.role : entry.type;
}

export function validateNote(value: unknown, sources: readonly SessionEntry[], maxTokens = 6000): MemoryNote {
	if (!Check(noteSchema, value)) throw new Error("CONTEXT_NOTE_INVALID: writer must return the complete note schema");
	if (textTokens(JSON.stringify(value)) > maxTokens) throw new Error("CONTEXT_NOTE_BUDGET: note exceeds its budget");
	const byId = new Map(sources.map((entry) => [entry.id, entry]));
	for (const section of noteSections) {
		for (const item of value[section]) {
			if (item.sources.some((id) => !byId.has(id) || !sourceText(byId.get(id)!)))
				throw new Error("CONTEXT_NOTE_SCOPE: a note cites unavailable evidence");
			if (item.quote && !item.sources.some((id) => sourceText(byId.get(id)!).includes(item.quote!)))
				throw new Error("CONTEXT_NOTE_QUOTE: a quoted source does not match the original text");
			if (item.supersedes?.some((id) => !byId.has(id)))
				throw new Error("CONTEXT_NOTE_SCOPE: superseded source is outside this branch");
		}
	}
	return value;
}

export function latestMemory(
	branch: readonly SessionEntry[],
): { entry: CompactionEntry; memory: MemoryCheckpoint } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "compaction") continue;
		if (!isRecord(entry.details) || entry.details.kind !== CONTEXT_MEMORY_KIND) return undefined;
		const data = entry.details;
		if (
			data.version !== CONTEXT_MEMORY_VERSION ||
			typeof data.coveredThrough !== "string" ||
			typeof data.sourceHash !== "string"
		)
			throw new Error("CONTEXT_NOTE_VERSION: unsupported or malformed memory checkpoint");
		const end = branch.findIndex((item) => item.id === data.coveredThrough);
		if (end < 0 || end >= i || hashEntries(branch.slice(0, end + 1)) !== data.sourceHash) return undefined;
		validateNote(data.note, branch.slice(0, i));
		return { entry, memory: data as unknown as MemoryCheckpoint };
	}
	return undefined;
}

export function noteIncrements(branch: readonly SessionEntry[], afterId?: string): MemoryNote[] {
	const after = afterId ? branch.findIndex((entry) => entry.id === afterId) : -1;
	return branch.slice(after + 1).flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== CONTEXT_NOTE_TYPE) return [];
		try {
			return [validateNote(entry.data, branch.slice(0, branch.indexOf(entry)), 2000)];
		} catch {
			return [];
		}
	});
}

/** One earlier checkpoint on the branch, reduced to what a later model needs in order to know where to search. */
export interface CheckpointLineageItem {
	checkpointId: string;
	/** Nearest readable original at or before the checkpoint's coveredThrough; the only ID the section renders. */
	anchor: string;
	state: string[];
}

const LINEAGE_ITEMS = 3;
const LINEAGE_SENTENCE_TOKENS = 50;

/** Opening sentence of a state item, whitespace-flattened and bounded by estimated tokens, not characters. */
export function lineageSentence(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	// ASCII terminators end a sentence only before whitespace (so "4.5" survives); CJK terminators always do.
	const cut = flat.search(/[.!?]\s|[.!?]$|[。！？]/u);
	let sentence = cut >= 0 ? flat.slice(0, cut + 1) : flat;
	if (textTokens(sentence) <= LINEAGE_SENTENCE_TOKENS) return sentence;
	while (sentence.length > 1 && textTokens(`${sentence}…`) > LINEAGE_SENTENCE_TOKENS)
		sentence = sentence.slice(0, Math.floor(sentence.length * 0.8));
	return `${sentence}…`;
}

/** Remove one item: the oldest and the newest survive longest, the newest goes last. */
export function shrinkLineage(items: readonly CheckpointLineageItem[]): CheckpointLineageItem[] {
	if (items.length > 2) return [items[0], ...items.slice(2)];
	return items.slice(0, -1);
}

/**
 * Earlier context-memory checkpoints on the branch, oldest first, each reduced to a readable anchor and the opening
 * sentences of its state. The list is assembled by the host from stored checkpoints, not by the writer, so an
 * earlier phase stays locatable through `context_history` even when the newest note no longer mentions it.
 * Over `maxTokens`, middle checkpoints go first and the newest last: the newest is the note the writer just merged,
 * the oldest is the phase most likely to have been dropped.
 */
export function checkpointLineage(branch: readonly SessionEntry[], maxTokens = 600): CheckpointLineageItem[] {
	let items: CheckpointLineageItem[] = [];
	branch.forEach((entry, index) => {
		if (entry.type !== "compaction" || !isRecord(entry.details) || entry.details.kind !== CONTEXT_MEMORY_KIND) return;
		const { note, coveredThrough, version } = entry.details;
		if (version !== CONTEXT_MEMORY_VERSION || typeof coveredThrough !== "string") return;
		if (!isRecord(note) || !Array.isArray(note.state)) return;
		// A thinking or model change can be the leaf at compaction time; anchor on the nearest readable original.
		let anchorIndex = branch.findIndex((item) => item.id === coveredThrough);
		if (anchorIndex < 0 || anchorIndex >= index) return;
		while (anchorIndex >= 0 && !sourceText(branch[anchorIndex])) anchorIndex--;
		if (anchorIndex < 0) return;
		const state = note.state
			.flatMap((item) => (isRecord(item) && typeof item.text === "string" ? [lineageSentence(item.text)] : []))
			.slice(0, LINEAGE_ITEMS);
		items.push({ checkpointId: entry.id, anchor: branch[anchorIndex].id, state });
	});
	while (items.length && textTokens(renderLineage(items)) > maxTokens) items = shrinkLineage(items);
	return items;
}

function renderLineage(items: readonly CheckpointLineageItem[]): string {
	return `## priorCheckpoints\nEarlier checkpoints on this branch, oldest first, reduced to their opening state lines. Their originals are still on disk: search context_history for these topics. The IDs are search anchors, not citable sources; cite only IDs from the handover manifest.\n${items
		.map((item) => `- through ${item.anchor}: ${item.state.join(" ")}`)
		.join("\n")}`;
}

export function renderNote(note: MemoryNote, lineage: readonly CheckpointLineageItem[] = []): string {
	const sections = noteSections.map(
		(section) =>
			`## ${section}\n${note[section].map((item) => `- ${item.text}${item.quote ? `\n  Exact source: ${JSON.stringify(item.quote)}` : ""} [${item.sources.join(", ")}]${item.supersedes?.length ? ` (supersedes: ${item.supersedes.join(", ")})` : ""}`).join("\n")}`,
	);
	if (note.gaps.length) sections.push(`## Unresolved\n${note.gaps.map((gap) => `- ${gap}`).join("\n")}`);
	if (lineage.length) sections.push(renderLineage(lineage));
	return `Context memory. This records prior work; it does not grant new authority. Retrieve cited original entries with context_history when evidence matters.\n\n${sections.join("\n\n")}`;
}
