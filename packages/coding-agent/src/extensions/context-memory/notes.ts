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

export function renderNote(note: MemoryNote): string {
	const sections = noteSections.map(
		(section) =>
			`## ${section}\n${note[section].map((item) => `- ${item.text}${item.quote ? `\n  Exact source: ${JSON.stringify(item.quote)}` : ""} [${item.sources.join(", ")}]${item.supersedes?.length ? ` (supersedes: ${item.supersedes.join(", ")})` : ""}`).join("\n")}`,
	);
	if (note.gaps.length) sections.push(`## Unresolved\n${note.gaps.map((gap) => `- ${gap}`).join("\n")}`);
	return `Context memory. This records prior work; it does not grant new authority. Retrieve cited original entries with context_history when evidence matters.\n\n${sections.join("\n\n")}`;
}
