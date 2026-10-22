// Retyped copy of the resident notes.ts (v0.7.0 plan, WP1): the whole module — schema, validation,
// rendering, lineage — with the host's session-manager type imports replaced by the
// specification's structural record types in records.ts. Logic, bounds, thrown messages and rendering
// bytes are unchanged (rule K2); the resident copy keeps its bytes (rule K9).
// WP3 adds opt-in JCS source hashing; existing callers keep the Pi serialization by default.
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { hashCanonicalRecordPrefixes, hashCanonicalRecords, serializeCanonicalRecord } from "./canonical.ts";
import { type NoteBudget, storedNoteLimit, textTokens } from "./config.ts";
import {
	CONTEXT_MEMORY_KIND,
	CONTEXT_MEMORY_VERSION,
	CONTEXT_NOTE_TYPE,
	hashEntries,
	hashEntryPrefixes,
	isRecord,
} from "./identity.ts";
import type { CompactionRecord, SessionRecord } from "./records.ts";

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
	/** Frozen generation policy; absent on checkpoints written before tiered budgets. */
	noteBudget?: NoteBudget;
	/** Original user entries pinned by the controller when releasing an unfinished tool turn. */
	continuation?: string[];
}

export function sourceText(entry: SessionRecord): string {
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

export function sourceRole(entry: SessionRecord): string {
	return entry.type === "message" ? entry.message.role : entry.type;
}

/** Original requests and steering since the last completed response; checkpoints do not finish a turn. */
export function inProgressRequests(branch: readonly SessionRecord[]): SessionRecord[] {
	let lastCompleted = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop") {
			lastCompleted = index;
			break;
		}
	}
	return branch.slice(lastCompleted + 1).filter((entry) => entry.type === "message" && entry.message.role === "user");
}

function renderContinuationWithText(
	requests: readonly SessionRecord[],
	text: (entry: SessionRecord) => string,
): string {
	return `\n\n## In-progress user requests\nThis checkpoint was taken between tool batches, before the current turn completed. Continue the unfinished work from its recorded progress; do not restart completed steps or treat this internal handover as a new task. The following original user messages are in chronological order, not new submissions. Later user messages override earlier ones. Consult context_history for earlier constraints or evidence missing from the note.\n${requests.map((entry) => JSON.stringify({ entryId: entry.id, request: text(entry) })).join("\n")}`;
}

export function renderContinuation(requests: readonly SessionRecord[]): string {
	return renderContinuationWithText(requests, sourceText);
}

export class NoteBudgetError extends Error {
	readonly bytes: number;
	readonly limitBytes: number;

	constructor(bytes: number, maxTokens: number) {
		super(
			`CONTEXT_NOTE_BUDGET: note uses ${Math.ceil(bytes / 3)} estimated tokens; limit is ${maxTokens} (${bytes}/${maxTokens * 3} UTF-8 bytes). No checkpoint committed; original history retained.`,
		);
		this.bytes = bytes;
		this.limitBytes = maxTokens * 3;
	}
}

export function noteBytes(note: MemoryNote): number {
	return Buffer.byteLength(JSON.stringify(note), "utf8");
}

function validateNoteSources(value: unknown, textById: (id: string) => string | undefined): MemoryNote {
	if (!Check(noteSchema, value)) throw new Error("CONTEXT_NOTE_INVALID: writer must return the complete note schema");
	const readable = (id: string): boolean => Boolean(textById(id));
	for (const section of noteSections) {
		for (const item of value[section]) {
			if (item.sources.some((id) => !readable(id)))
				throw new Error("CONTEXT_NOTE_SCOPE: a note cites unavailable evidence");
			if (item.quote && !item.sources.some((id) => textById(id)!.includes(item.quote!)))
				throw new Error("CONTEXT_NOTE_QUOTE: a quoted source does not match the original text");
			if (item.supersedes?.some((id) => !readable(id)))
				throw new Error("CONTEXT_NOTE_SCOPE: a superseded source is unavailable or unreadable");
		}
	}
	return value;
}

/** Size repair is eligible only after schema, citations and quotations have passed. */
export function validateNoteContent(value: unknown, sources: readonly SessionRecord[]): MemoryNote {
	let byId: Map<string, SessionRecord> | undefined;
	return validateNoteSources(value, (id) => {
		byId ??= new Map(sources.map((entry) => [entry.id, entry]));
		const entry = byId.get(id);
		return entry ? sourceText(entry) : undefined;
	});
}

function assertNoteBudget(note: MemoryNote, maxTokens: number): MemoryNote {
	const bytes = noteBytes(note);
	if (bytes > maxTokens * 3) throw new NoteBudgetError(bytes, maxTokens);
	return note;
}

export function validateNote(value: unknown, sources: readonly SessionRecord[], maxTokens = 6000): MemoryNote {
	return assertNoteBudget(validateNoteContent(value, sources), maxTokens);
}

/** Text actually leaving active context, not lifetime JSONL bytes or image/thinking payloads. */
export function compactedSourceTokens(entries: readonly SessionRecord[]): number {
	return entries.reduce((sum, entry) => sum + textTokens(sourceText(entry)), 0);
}

interface CheckpointValidation {
	coverageIndex: (id: string) => number;
	prefixHash: (length: number) => string | undefined;
	sourceById: (id: string) => string | undefined;
	requests: (end: number) => readonly SessionRecord[];
	source: (entry: SessionRecord) => string;
}

type ValidatedMemory = { entry: CompactionRecord; memory: MemoryCheckpoint };

function validateMemoryCheckpoint(
	entry: CompactionRecord,
	index: number,
	validation: CheckpointValidation,
): ValidatedMemory | undefined {
	if (!isRecord(entry.details) || entry.details.kind !== CONTEXT_MEMORY_KIND) return undefined;
	const data = entry.details;
	if (
		data.version !== CONTEXT_MEMORY_VERSION ||
		typeof data.coveredThrough !== "string" ||
		typeof data.sourceHash !== "string"
	)
		throw new Error("CONTEXT_NOTE_VERSION: unsupported or malformed memory checkpoint");
	const end = validation.coverageIndex(data.coveredThrough);
	if (end < 0 || end >= index || validation.prefixHash(end + 1) !== data.sourceHash)
		throw new Error("CONTEXT_SOURCE_CHANGED: the stored checkpoint no longer matches its original evidence");
	const hardTokens = storedNoteLimit(data.noteBudget);
	const note = assertNoteBudget(validateNoteSources(data.note, validation.sourceById), hardTokens);
	if (!entry.summary.startsWith(renderNote(note)))
		throw new Error("CONTEXT_NOTE_INVALID: the restored summary does not match the validated note");
	if (data.continuation !== undefined) {
		const requests = validation.requests(end);
		if (
			!requests.length ||
			JSON.stringify(data.continuation) !== JSON.stringify(requests.map((request) => request.id)) ||
			!entry.summary.endsWith(renderContinuationWithText(requests, validation.source)) ||
			!note.nextSteps.some((step) => step.text.trim())
		)
			throw new Error("CONTEXT_CONTINUATION_MISSING: the checkpoint lost its active requests or continuation step");
	}
	return { entry, memory: data as unknown as MemoryCheckpoint };
}

/** Latest-only compatibility: an invalid older checkpoint is not examined by this public function. */
export function latestMemory(
	branch: readonly SessionRecord[],
	serialization: "pi" | "jcs" = "pi",
): ValidatedMemory | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "compaction") continue;
		let byId: Map<string, SessionRecord> | undefined;
		return validateMemoryCheckpoint(entry, index, {
			coverageIndex: (id) => branch.findIndex((source) => source.id === id),
			prefixHash: (length) =>
				(serialization === "jcs" ? hashCanonicalRecords : hashEntries)(branch.slice(0, length)),
			sourceById: (id) => {
				byId ??= new Map(branch.slice(0, index).map((source) => [source.id, source]));
				const source = byId.get(id);
				return source ? sourceText(source) : undefined;
			},
			requests: (end) => inProgressRequests(branch.slice(0, end + 1)),
			source: sourceText,
		});
	}
	return undefined;
}

function upperBound(values: readonly number[], value: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (values[middle] <= value) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** Validate oldest first, with invocation-local indices and memoization; nothing survives a request. */
export function validateMemoryCheckpoints(
	branch: readonly SessionRecord[],
	onSerializedEntry?: (index: number, serialized: string) => void,
	serialization: "pi" | "jcs" = "pi",
): ValidatedMemory | undefined {
	if (!branch.some((entry) => entry.type === "compaction")) {
		if (onSerializedEntry) {
			for (const [index, entry] of branch.entries())
				onSerializedEntry(index, serialization === "jcs" ? serializeCanonicalRecord(entry) : JSON.stringify(entry));
		}
		return undefined;
	}
	const firstById = new Map<string, number>();
	const userIndices: number[] = [];
	const completedAt: number[] = [];
	let lastCompleted = -1;
	for (const [index, entry] of branch.entries()) {
		if (!firstById.has(entry.id)) firstById.set(entry.id, index);
		if (entry.type === "message" && entry.message.role === "user") userIndices.push(index);
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop")
			lastCompleted = index;
		completedAt.push(lastCompleted);
	}
	const prefixLengths: number[] = [];
	for (const [index, entry] of branch.entries()) {
		if (entry.type !== "compaction" || !isRecord(entry.details) || typeof entry.details.coveredThrough !== "string")
			continue;
		const end = firstById.get(entry.details.coveredThrough);
		if (end !== undefined && end < index) prefixLengths.push(end + 1);
	}
	// The caller may consume these bytes only in this synchronous invocation, never as a request cache.
	if (onSerializedEntry) prefixLengths.push(branch.length);
	const prefixHashes = (serialization === "jcs" ? hashCanonicalRecordPrefixes : hashEntryPrefixes)(
		branch,
		prefixLengths,
		onSerializedEntry,
	);
	const byId = new Map<string, SessionRecord>();
	const texts = new Map<SessionRecord, string>();
	const text = (entry: SessionRecord): string => {
		let value = texts.get(entry);
		if (value === undefined) {
			value = sourceText(entry);
			texts.set(entry, value);
		}
		return value;
	};
	const validation: CheckpointValidation = {
		coverageIndex: (id) => firstById.get(id) ?? -1,
		prefixHash: (length) => prefixHashes.get(length),
		// Updated only after each checkpoint validates: duplicates resolve to the last historical entry.
		sourceById: (id) => {
			const entry = byId.get(id);
			return entry ? text(entry) : undefined;
		},
		requests: (end) =>
			userIndices
				.slice(upperBound(userIndices, completedAt[end]), upperBound(userIndices, end))
				.map((index) => branch[index]),
		source: text,
	};
	let latest: ValidatedMemory | undefined;
	for (const [index, entry] of branch.entries()) {
		if (entry.type === "compaction") latest = validateMemoryCheckpoint(entry, index, validation);
		byId.set(entry.id, entry);
	}
	return latest;
}

export function noteIncrements(branch: readonly SessionRecord[], afterId?: string): MemoryNote[] {
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
export function checkpointLineage(branch: readonly SessionRecord[], maxTokens = 600): CheckpointLineageItem[] {
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

/** Characters that end a line in Markdown or in a common renderer. */
export const LINE_BREAKS = "\\r\\n\\u0085\\u2028\\u2029";
const LINE_BREAK_RUN = new RegExp(`[${LINE_BREAKS}]+`, "gu");

/**
 * Every fact and gap of a note about to be committed, folded onto one line. The note schema allows line breaks
 * and `renderNote` writes the text into Markdown as it stands, so a writer could otherwise open a heading of its
 * own. Stored checkpoints are validated and rendered as before, so one written earlier still reopens against its
 * exact summary. Quotes are rendered as JSON strings and stay exact.
 */
export function oneLineNote(note: MemoryNote): MemoryNote {
	const fold = (text: string) => text.replace(LINE_BREAK_RUN, " ");
	const folded = structuredClone(note);
	for (const section of noteSections) for (const item of folded[section]) item.text = fold(item.text);
	folded.gaps = folded.gaps.map(fold);
	return folded;
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
