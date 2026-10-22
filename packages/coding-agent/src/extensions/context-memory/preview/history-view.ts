import { createHash } from "node:crypto";
import type { SessionEntry, SessionProjection } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { hashEntries, noteSections, sourceRole, sourceText } from "../../../../../compaction-core/src/notes.ts";
import type { SessionRecord } from "../../../../../compaction-core/src/records.ts";
import { textTokens } from "../config.ts";
import { type HistoryExcerpt, type HistoryPage, type HistorySnapshot, queryHistory } from "../history.ts";
import { CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION, isRecord } from "../identity.ts";

/** Pi's entries satisfy the core's structural record shapes; the union is widened here, never converted (records.ts). */
const asRecord = (entry: SessionEntry): SessionRecord => entry as unknown as SessionRecord;

/** Note sections as recorded by committed checkpoints, plus edits and errors read from tool records. */
export const HISTORY_VIEW_KINDS = [...noteSections, "edits", "errors"] as const;
export type HistoryViewKind = (typeof HISTORY_VIEW_KINDS)[number];
type NoteKind = (typeof noteSections)[number];
/** Part of every cursor signature: a cursor indexes this version's ordering. Prices and marks do not reorder it. */
const VIEW_VERSION = "view-v2";
const EXCERPT_CHARS = 400;
const EDIT_TOOLS = new Set(["edit", "write"]);
/**
 * The most a low-detail read returns of an entry, in estimated tokens of its JSON-escaped text. A proposal: whether
 * low detail becomes the default for reads, and at what bound, is the maintainer's decision from the probes (M8).
 */
export const LOW_DETAIL_TOKENS = 200;

/** Whether an entry's full text is in the model's current context. */
export type InContext = (entryId: string) => boolean;
const NONE_IN_CONTEXT: InContext = () => false;

/**
 * Entries whose full text the model holds: in the active projection and not reduced. A reduced entry shows only its
 * one line in context, so it is not marked. Reductions are the caller's to supply; until they exist, none is.
 */
export function inContextEntries(
	projection: Pick<SessionProjection, "entries">,
	isReduced: (entryId: string) => boolean = () => false,
): InContext {
	const active = new Set(
		projection.entries.filter((entry) => entry.messages.length).map((entry) => entry.sourceEntry.id),
	);
	return (entryId) => active.has(entryId) && !isReduced(entryId);
}

/**
 * Estimated tokens of what `context_history` read returns for `entry` in full: every page of an unchanged `read`,
 * measured as the tool's text. The read runs on a one-entry copy of the snapshot, so its cost does not grow with the
 * branch, and the branch position is put back, so each page has the bytes the real read returns. An entry `read`
 * refuses, one without text or with an ID the query schema rejects, costs nothing to read.
 */
export function readTokens(snapshot: HistorySnapshot, entry: SessionEntry, position: number): number {
	if (!sourceText(asRecord(entry)) || entry.id.length > 64) return 0;
	const single: HistorySnapshot = { ...snapshot, entries: [entry] };
	let tokens = 0;
	let cursor: string | undefined;
	do {
		const page = queryHistory(single, { operation: "read", entryId: entry.id, ...(cursor ? { cursor } : {}) });
		tokens += textTokens(JSON.stringify({ ...page, entries: page.entries.map((hit) => ({ ...hit, position })) }));
		cursor = page.cursor;
	} while (cursor);
	return tokens;
}

/**
 * The longest `text.slice(start, end)` of at most `limit` characters that `fits`, which must hold for every shorter
 * slice it holds for.
 */
export function longestFitting(text: string, start: number, limit: number, fits: (slice: string) => boolean): string {
	let low = start;
	let high = Math.min(text.length, start + limit);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(text.slice(start, middle))) low = middle;
		else high = middle - 1;
	}
	// Never end between the two halves of a surrogate pair.
	const code = text.charCodeAt(low - 1);
	return text.slice(start, low > start && code >= 0xd800 && code <= 0xdbff ? low - 1 : low);
}

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
		detail: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("full")], {
				description:
					"For read: low returns the start of the entry and its full cost; full, the default, all of it.",
			}),
		),
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

/** The cost of a full read and whether it is needed; added to each item of a page and each search hit. */
interface Priced {
	/** Estimated tokens `read` returns for the entry in full; for a fact, for all its sources together. */
	readTokens: number;
	/** The entry, or every source of a fact, is already in the current context in full. */
	inContext?: true;
}

/** A search hit with what reading its entry in full costs, and whether the model already holds it. */
export interface PricedHit extends HistoryExcerpt, Priced {}

export interface PricedSearchPage extends Omit<HistoryPage, "entries"> {
	entries: PricedHit[];
}

/** A low-detail read: the start of one entry, bounded by `LOW_DETAIL_TOKENS`, with the full read's cost stated. */
export interface LowDetailPage extends Omit<HistoryPage, "entries" | "cursor"> {
	detail: "low";
	entries: (PricedHit & { complete: boolean })[];
}

/** A fact a committed checkpoint recorded. The summary is the writer's wording; the excerpt is the evidence. */
export interface NoteViewItem extends Priced {
	kind: NoteKind;
	summary: string;
	quote?: string;
	sources: Located[];
	supersedes?: string[];
	/**
	 * Sources of later facts in this section whose `supersedes` names one of this fact's sources, when they account
	 * for every fact of the section on that source.
	 */
	supersededBy?: string[];
	/**
	 * Sources of later facts that name one of this fact's sources in `supersedes` without saying which fact they
	 * replace: they sit in another section, or the section holds more facts on that source than revisions naming it.
	 */
	sourceRevisedBy?: string[];
	/** Branch position of the first checkpoint that recorded the fact. */
	recordedAt: number;
	/** The newest checkpoint restates the fact, so the current note already carries it. */
	inLatestCheckpoint: boolean;
	excerpt: Excerpt;
}

export interface EditViewItem extends Priced {
	kind: "edits";
	entryId: string;
	position: number;
	tool: string;
	path: string;
	/** What the paired tool result reported; `no-result` when none is on the branch. */
	outcome: "ok" | "error" | "no-result";
}

export interface ErrorViewItem extends Priced {
	kind: "errors";
	entryId: string;
	role: string;
	position: number;
	tool?: string;
	exitCode?: number;
	excerpt: Excerpt;
}

export type HistoryViewItem = NoteViewItem | EditViewItem | ErrorViewItem;
/** An item before its page prices it: only the items a page returns are read for their cost. */
type NoteDraft = Omit<NoteViewItem, keyof Priced>;
type ViewDraft = NoteDraft | Omit<EditViewItem, keyof Priced> | Omit<ErrorViewItem, keyof Priced>;

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
	const text = sourceText(asRecord(entry));
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
function noteItems(entries: readonly SessionEntry[], kind: NoteKind, terms: readonly string[]): NoteDraft[] {
	const position = new Map(entries.map((entry, index) => [entry.id, index]));
	// Every section's distinct facts, in their latest restatement, so a revision can be matched to the facts it
	// may replace.
	const distinct = new Map<string, { section: NoteKind; sources: string[]; supersedes: string[] }>();
	const recorded = new Map<string, { item: Omit<NoteDraft, "inLatestCheckpoint">; lastSeen: number }>();
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
				const quote = typeof fact.quote === "string" ? fact.quote : undefined;
				// A restated fact keeps its sources and quotation while its wording may change. Facts sharing both
				// within one checkpoint are told apart by order, so the n-th meets the n-th of the next checkpoint.
				const base = JSON.stringify([section, [...sources].sort(), quote ?? ""]);
				const occurrence = seen.get(base) ?? 0;
				seen.set(base, occurrence + 1);
				const key = `${base}#${occurrence}`;
				distinct.set(key, { section, sources, supersedes });
				if (section !== kind) continue;
				const newest = sources.reduce((a, b) => (position.get(a)! >= position.get(b)! ? a : b));
				recorded.set(key, {
					item: {
						kind,
						summary: fact.text,
						...(quote ? { quote } : {}),
						sources: sources.map((id) => ({
							entryId: id,
							role: sourceRole(asRecord(entries[position.get(id)!])),
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
	// `supersedes` names entries, not facts. Revisions replace the facts of their own section on the entry they name
	// when those facts are no more than the revisions, the count `mergeWorkNotes` checks before it drops any.
	// Otherwise, and for revisions in other sections, the view says only that the source was revised.
	const revisions = new Map<string, { section: NoteKind; sources: string[] }[]>();
	const onSource = new Map<string, number>();
	for (const fact of distinct.values()) {
		for (const old of fact.supersedes) {
			const list = revisions.get(old);
			if (list) list.push(fact);
			else revisions.set(old, [fact]);
		}
		if (fact.section === kind)
			for (const id of fact.sources)
				if (!fact.supersedes.includes(id)) onSource.set(id, (onSource.get(id) ?? 0) + 1);
	}
	return [...recorded.values()].map(({ item, lastSeen }) => {
		const own = new Set(item.sources.map((source) => source.entryId));
		const replaced = new Set<string>();
		const revised = new Set<string>();
		for (const { entryId } of item.sources) {
			const later = revisions.get(entryId) ?? [];
			const same = later.filter((fact) => fact.section === kind);
			const target = same.length && (onSource.get(entryId) ?? 0) <= same.length ? replaced : revised;
			for (const fact of same) for (const id of fact.sources) target.add(id);
			for (const fact of later) if (fact.section !== kind) for (const id of fact.sources) revised.add(id);
		}
		const supersededBy = [...replaced].filter((id) => !own.has(id));
		const sourceRevisedBy = [...revised].filter((id) => !own.has(id) && !replaced.has(id));
		return {
			...item,
			...(supersededBy.length ? { supersededBy } : {}),
			...(sourceRevisedBy.length ? { sourceRevisedBy } : {}),
			inLatestCheckpoint: lastSeen === latest,
		};
	});
}

function editItems(entries: readonly SessionEntry[]): Omit<EditViewItem, keyof Priced>[] {
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

function errorItems(entries: readonly SessionEntry[], terms: readonly string[]): Omit<ErrorViewItem, keyof Priced>[] {
	return entries.flatMap((entry, position): Omit<ErrorViewItem, keyof Priced>[] => {
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
function newest(item: ViewDraft): number {
	return item.kind === "edits" || item.kind === "errors"
		? item.position
		: Math.max(...item.sources.map((source) => source.position));
}

function searchable(item: ViewDraft, entries: readonly SessionEntry[]): string {
	if (item.kind === "edits") return `${item.tool} ${item.path}`;
	if (item.kind === "errors") return `${item.tool ?? ""} ${sourceText(asRecord(entries[item.position]))}`;
	return [
		item.summary,
		item.quote ?? "",
		...item.sources.map((source) => sourceText(asRecord(entries[source.position]))),
	].join("\n");
}

/** Prices drafts against one snapshot, reading each entry's cost once. */
function pricer(snapshot: HistorySnapshot, inContext: InContext): (draft: ViewDraft) => HistoryViewItem {
	const costs = new Map<number, number>();
	const cost = (position: number) => {
		let tokens = costs.get(position);
		if (tokens === undefined) {
			tokens = readTokens(snapshot, snapshot.entries[position], position);
			costs.set(position, tokens);
		}
		return tokens;
	};
	const mark = (held: boolean) => (held ? { inContext: true as const } : {});
	return (draft) => {
		if (draft.kind === "edits" || draft.kind === "errors")
			return { ...draft, readTokens: cost(draft.position), ...mark(inContext(draft.entryId)) };
		return {
			...draft,
			readTokens: draft.sources.reduce((sum, source) => sum + cost(source.position), 0),
			...mark(draft.sources.every((source) => inContext(source.entryId))),
		};
	};
}

/**
 * One kind of item on the snapshot's branch, newest first, computed on every call: nothing is stored, so nothing
 * can go stale, and only entries in the snapshot are listed. A cursor is bound to the snapshot, the kind, the query
 * and the view version; after the branch grows it continues on the prefix it was issued for. Each returned item
 * states `readTokens` and, when its entries are already in context in full, `inContext`.
 */
export function listHistory(
	snapshot: HistorySnapshot,
	request: Pick<PreviewHistoryQuery, "kind" | "query" | "cursor">,
	budgetTokens = 4000,
	inContext: InContext = NONE_IN_CONTEXT,
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
	const all: ViewDraft[] =
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
	const price = pricer(snapshot, inContext);
	let remaining = Math.max(512, Math.min(4000, budgetTokens)) - 350;
	for (; index < items.length; index++) {
		const item = price(items[index]);
		const tokens = textTokens(JSON.stringify(item));
		if (tokens > remaining && page.items.length) break;
		page.items.push(item);
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

/**
 * A `context_history` search page with each hit priced and marked. The hits, their order and the cursor are the
 * shared search's own; a hit's position indexes the snapshot, or the prefix a cursor pinned, which starts it.
 */
export function priceSearch(
	page: HistoryPage,
	snapshot: HistorySnapshot,
	inContext: InContext = NONE_IN_CONTEXT,
): PricedSearchPage {
	return {
		...page,
		entries: page.entries.map((hit) => {
			const entry = snapshot.entries[hit.position];
			const tokens = entry?.id === hit.entryId ? readTokens(snapshot, entry, hit.position) : 0;
			return { ...hit, readTokens: tokens, ...(inContext(hit.entryId) ? { inContext: true as const } : {}) };
		}),
	};
}

/**
 * Low detail for `read`: the start of the entry, at most `LOW_DETAIL_TOKENS` estimated tokens of its text, with what
 * the full read costs. Refused as `read` refuses, the newest entry under a duplicated ID first; it has no
 * continuation, since the full read pages the entry from its start.
 */
export function readLowDetail(
	snapshot: HistorySnapshot,
	request: Pick<PreviewHistoryQuery, "entryId" | "cursor">,
	inContext: InContext = NONE_IN_CONTEXT,
): LowDetailPage {
	if (request.cursor)
		throw new Error("HISTORY_QUERY_INVALID: a low-detail read has no continuation; read with detail full instead");
	if (!request.entryId) throw new Error("HISTORY_ENTRY_REQUIRED");
	const position = snapshot.entries.findLastIndex((entry) => entry.id === request.entryId);
	const entry = snapshot.entries[position];
	const text = entry ? sourceText(asRecord(entry)) : "";
	if (!entry || !text) throw new Error("HISTORY_SCOPE_DENIED: entry is not in this readable scope");
	const head = longestFitting(
		text,
		0,
		LOW_DETAIL_TOKENS * 3,
		(slice) => textTokens(JSON.stringify(slice)) <= LOW_DETAIL_TOKENS,
	);
	const tokens = readTokens(snapshot, entry, position);
	const complete = head.length === text.length;
	return {
		sessionId: snapshot.sessionId,
		leafId: snapshot.leafId,
		scopeHash: snapshot.scopeHash,
		detail: "low",
		entries: [
			{
				entryId: entry.id,
				parentId: entry.parentId,
				role: sourceRole(asRecord(entry)),
				position,
				offset: 0,
				text: head,
				complete,
				readTokens: tokens,
				...(inContext(entry.id) ? { inContext: true as const } : {}),
			},
		],
		...(complete
			? {}
			: {
					message: `Low detail: the start of the entry only. Reading it in full returns about ${tokens} tokens; read it again with detail full if it is needed.`,
				}),
	};
}
