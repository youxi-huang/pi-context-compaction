import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { textTokens } from "../config.ts";
import type { HistorySnapshot } from "../history.ts";
import { CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION, isRecord } from "../identity.ts";
import { hashEntries, noteSections, sourceRole, sourceText } from "../notes.ts";

/** Note sections as recorded by committed checkpoints, plus edits and errors read from tool records. */
export const HISTORY_VIEW_KINDS = [...noteSections, "edits", "errors"] as const;
export type HistoryViewKind = (typeof HISTORY_VIEW_KINDS)[number];
type NoteKind = (typeof noteSections)[number];
/** Part of every cursor signature: a cursor indexes this version's ordering. */
const VIEW_VERSION = "view-v1";
const EXCERPT_CHARS = 400;
const EDIT_TOOLS = new Set(["edit", "write"]);

/** The preview's `context_history` parameters: search and read as before, and a typed list. */
export const previewHistorySchema = Type.Object(
	{
		operation: Type.Union([Type.Literal("search"), Type.Literal("read"), Type.Literal("list")]),
		query: Type.Optional(Type.String({ maxLength: 1000 })),
		entryId: Type.Optional(Type.String({ maxLength: 64 })),
		kind: Type.Optional(
			// Spelled out: a mapped array would lose the literal types.
			Type.Union(
				[
					Type.Literal("instructions"),
					Type.Literal("failedPaths"),
					Type.Literal("reasons"),
					Type.Literal("state"),
					Type.Literal("nextSteps"),
					Type.Literal("files"),
					Type.Literal("edits"),
					Type.Literal("errors"),
				],
				{
					description:
						"For list: instructions (constraints), reasons (decisions), failedPaths, files, nextSteps, state, edits or errors.",
				},
			),
		),
		cursor: Type.Optional(
			Type.String({
				maxLength: 2000,
				description:
					"Continuation cursor. Repeat the original operation, query, entryId, kind and grantId unchanged.",
			}),
		),
		grantId: Type.Optional(Type.String({ maxLength: 128 })),
	},
	{ additionalProperties: false },
);
export type PreviewHistoryQuery = Static<typeof previewHistorySchema>;

interface Located {
	entryId: string;
	role: string;
	position: number;
}

interface Excerpt {
	entryId: string;
	offset: number;
	text: string;
}

/** A fact a committed checkpoint recorded. The summary is the writer's wording; the excerpt is the evidence. */
export interface NoteViewItem {
	kind: NoteKind;
	summary: string;
	quote?: string;
	sources: Located[];
	supersedes?: string[];
	/** Sources of later facts whose `supersedes` names one of this fact's sources. */
	supersededBy?: string[];
	/** Branch position of the first checkpoint that recorded the fact. */
	recordedAt: number;
	/** The newest checkpoint restates the fact, so the current note already carries it. */
	inLatestCheckpoint: boolean;
	excerpt: Excerpt;
}

export interface EditViewItem {
	kind: "edits";
	entryId: string;
	position: number;
	tool: string;
	path: string;
	/** What the paired tool result reported; `no-result` when none is on the branch. */
	outcome: "ok" | "error" | "no-result";
}

export interface ErrorViewItem {
	kind: "errors";
	entryId: string;
	role: string;
	position: number;
	tool?: string;
	exitCode?: number;
	excerpt: Excerpt;
}

export type HistoryViewItem = NoteViewItem | EditViewItem | ErrorViewItem;

export interface HistoryViewPage {
	sessionId: string;
	leafId: string | null;
	scopeHash: string;
	kind: HistoryViewKind;
	items: HistoryViewItem[];
	cursor?: string;
	message?: string;
}

/** The same term rules as `context_history` search; `history.ts` keeps its own copy private. */
export function viewTerms(query: string): string[] {
	const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
	const chinese = query.match(/[\p{Script=Han}]{2,}/gu) ?? [];
	return [
		...new Set([
			...words,
			...chinese.flatMap((word) => Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))),
		]),
	].slice(0, 64);
}

function excerpt(entry: SessionEntry, terms: readonly string[]): Excerpt {
	const text = sourceText(entry);
	const lower = text.toLocaleLowerCase();
	const hits = terms.map((term) => lower.indexOf(term)).filter((hit) => hit >= 0);
	const offset = Math.max(0, (hits.length ? Math.min(...hits) : 0) - 80);
	return { entryId: entry.id, offset, text: text.slice(offset, offset + EXCERPT_CHARS) };
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

const matches = (text: string, terms: readonly string[]) => {
	const lower = text.toLocaleLowerCase();
	return terms.some((term) => lower.includes(term));
};

/**
 * Facts of one section across every committed checkpoint on the branch, each once in its latest wording, with
 * revisions marked from every section's `supersedes`. Checkpoints were validated when the session became ready;
 * malformed values are skipped rather than trusted, and only sources on this branch are listed.
 */
function noteItems(entries: readonly SessionEntry[], kind: NoteKind, terms: readonly string[]): NoteViewItem[] {
	const position = new Map(entries.map((entry, index) => [entry.id, index]));
	const supersededBy = new Map<string, Set<string>>();
	const recorded = new Map<string, { item: Omit<NoteViewItem, "inLatestCheckpoint">; lastSeen: number }>();
	let latest = -1;
	entries.forEach((entry, index) => {
		if (entry.type !== "compaction" || !isRecord(entry.details)) return;
		const { kind: detailsKind, version, note } = entry.details;
		if (detailsKind !== CONTEXT_MEMORY_KIND || version !== CONTEXT_MEMORY_VERSION || !isRecord(note)) return;
		latest = index;
		const seen = new Map<string, number>();
		for (const section of noteSections) {
			const facts = note[section];
			if (!Array.isArray(facts)) continue;
			for (const fact of facts) {
				if (!isRecord(fact) || typeof fact.text !== "string") continue;
				const sources = strings(fact.sources)?.filter((id) => position.has(id));
				if (!sources?.length) continue;
				const supersedes = strings(fact.supersedes) ?? [];
				for (const old of supersedes) {
					const set = supersededBy.get(old) ?? new Set<string>();
					for (const id of sources) set.add(id);
					supersededBy.set(old, set);
				}
				if (section !== kind) continue;
				const quote = typeof fact.quote === "string" ? fact.quote : undefined;
				// A restated fact keeps its sources and quotation while its wording may change. Facts sharing both
				// within one checkpoint are told apart by order, so the n-th meets the n-th of the next checkpoint.
				const base = JSON.stringify([[...sources].sort(), quote ?? ""]);
				const occurrence = seen.get(base) ?? 0;
				seen.set(base, occurrence + 1);
				const key = `${base}#${occurrence}`;
				const newest = sources.reduce((a, b) => (position.get(a)! >= position.get(b)! ? a : b));
				recorded.set(key, {
					item: {
						kind,
						summary: fact.text,
						...(quote ? { quote } : {}),
						sources: sources.map((id) => ({
							entryId: id,
							role: sourceRole(entries[position.get(id)!]),
							position: position.get(id)!,
						})),
						...(supersedes.length ? { supersedes } : {}),
						recordedAt: recorded.get(key)?.item.recordedAt ?? index,
						excerpt: excerpt(entries[position.get(newest)!], terms),
					},
					lastSeen: index,
				});
			}
		}
	});
	return [...recorded.values()].map(({ item, lastSeen }) => {
		const own = new Set(item.sources.map((source) => source.entryId));
		const later = [
			...new Set(item.sources.flatMap((source) => [...(supersededBy.get(source.entryId) ?? [])])),
		].filter((id) => !own.has(id));
		return { ...item, ...(later.length ? { supersededBy: later } : {}), inLatestCheckpoint: lastSeen === latest };
	});
}

function editItems(entries: readonly SessionEntry[]): EditViewItem[] {
	const results = new Map<string, boolean>();
	for (const entry of entries)
		if (entry.type === "message" && entry.message.role === "toolResult")
			results.set(entry.message.toolCallId, entry.message.isError);
	return entries.flatMap((entry, position) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return [];
		return entry.message.content.flatMap((block) => {
			if (block.type !== "toolCall" || !EDIT_TOOLS.has(block.name)) return [];
			const path = block.arguments.path;
			if (typeof path !== "string") return [];
			const error = results.get(block.id);
			return [
				{
					kind: "edits" as const,
					entryId: entry.id,
					position,
					tool: block.name,
					path,
					outcome: error === undefined ? ("no-result" as const) : error ? ("error" as const) : ("ok" as const),
				},
			];
		});
	});
}

function errorItems(entries: readonly SessionEntry[], terms: readonly string[]): ErrorViewItem[] {
	return entries.flatMap((entry, position): ErrorViewItem[] => {
		if (entry.type !== "message") return [];
		const message = entry.message;
		if (message.role === "toolResult" && message.isError)
			return [
				{
					kind: "errors",
					entryId: entry.id,
					role: "toolResult",
					position,
					tool: message.toolName,
					excerpt: excerpt(entry, terms),
				},
			];
		if (message.role === "bashExecution" && typeof message.exitCode === "number" && message.exitCode !== 0)
			return [
				{
					kind: "errors",
					entryId: entry.id,
					role: "bashExecution",
					position,
					exitCode: message.exitCode,
					excerpt: excerpt(entry, terms),
				},
			];
		return [];
	});
}

/** Newest first: the latest source of a fact, or the record's own position. */
function newest(item: HistoryViewItem): number {
	return item.kind === "edits" || item.kind === "errors"
		? item.position
		: Math.max(...item.sources.map((source) => source.position));
}

function searchable(item: HistoryViewItem, entries: readonly SessionEntry[]): string {
	if (item.kind === "edits") return `${item.tool} ${item.path}`;
	if (item.kind === "errors") return `${item.tool ?? ""} ${sourceText(entries[item.position])}`;
	return [item.summary, item.quote ?? "", ...item.sources.map((source) => sourceText(entries[source.position]))].join(
		"\n",
	);
}

/**
 * One kind of item on the snapshot's branch, newest first, computed on every call: nothing is stored, so nothing
 * can go stale, and only entries in the snapshot are listed. A cursor is bound to the snapshot, the kind, the query
 * and the view version; after the branch grows it continues on the prefix it was issued for.
 */
export function listHistory(
	snapshot: HistorySnapshot,
	request: Pick<PreviewHistoryQuery, "kind" | "query" | "cursor">,
	budgetTokens = 4000,
): HistoryViewPage {
	const kind = request.kind;
	if (!kind) throw new Error("HISTORY_KIND_REQUIRED: list needs a kind");
	const signature = createHash("sha256")
		.update(JSON.stringify(["list", kind, request.query ?? "", VIEW_VERSION]))
		.digest("hex");
	let index = 0;
	if (request.cursor) {
		let cursor: unknown;
		try {
			cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
		} catch {
			throw new Error("HISTORY_CURSOR_INVALID");
		}
		if (
			!isRecord(cursor) ||
			cursor.sessionId !== snapshot.sessionId ||
			cursor.signature !== signature ||
			!Number.isSafeInteger(cursor.index) ||
			Number(cursor.index) < 0
		)
			throw new Error(
				"HISTORY_CURSOR_INVALID: repeat the original operation, kind and query with the cursor, or restart the list",
			);
		if (cursor.scope !== snapshot.scopeHash) {
			const end = snapshot.entries.findIndex((entry) => entry.id === cursor.leafId);
			const pinned = end >= 0 ? snapshot.entries.slice(0, end + 1) : [];
			if (!pinned.length || hashEntries(pinned) !== cursor.scope)
				throw new Error("HISTORY_CURSOR_INVALID: source is no longer on this branch");
			snapshot = { ...snapshot, leafId: pinned[pinned.length - 1].id, entries: pinned, scopeHash: cursor.scope };
		}
		index = Number(cursor.index);
	}
	const terms = viewTerms(request.query ?? "");
	const entries = snapshot.entries;
	const all: HistoryViewItem[] =
		kind === "edits"
			? editItems(entries)
			: kind === "errors"
				? errorItems(entries, terms)
				: noteItems(entries, kind, terms);
	const items = (terms.length ? all.filter((item) => matches(searchable(item, entries), terms)) : all).sort(
		(a, b) => newest(b) - newest(a),
	);
	const page: HistoryViewPage = {
		sessionId: snapshot.sessionId,
		leafId: snapshot.leafId,
		scopeHash: snapshot.scopeHash,
		kind,
		items: [],
	};
	let remaining = Math.max(512, Math.min(4000, budgetTokens)) - 350;
	for (; index < items.length; index++) {
		const tokens = textTokens(JSON.stringify(items[index]));
		if (tokens > remaining && page.items.length) break;
		page.items.push(items[index]);
		remaining -= tokens;
	}
	if (index < items.length)
		page.cursor = Buffer.from(
			JSON.stringify({
				sessionId: snapshot.sessionId,
				leafId: snapshot.leafId,
				scope: snapshot.scopeHash,
				signature,
				index,
			}),
		).toString("base64url");
	if (!page.items.length)
		page.message =
			"No items of this kind on this branch. The list comes from earlier checkpoints and tool records and can miss what a writer left out; search before concluding the history lacks it.";
	return page;
}
