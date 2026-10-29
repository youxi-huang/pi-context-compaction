// Retyped copy of the resident history.ts's retrieval half (v0.7.0 plan, WP1): `queryHistory` with
// the snapshot and page types, the host's `SessionEntry` type import replaced by the specification's
// structural record types in records.ts. Bounds and thrown messages are unchanged (rule K2); since
// ranking version 3 a search skips the retrieval tool's own results and centers each excerpt where
// the most query terms meet, which the frozen resident copy does not (rule K9 keeps its bytes).
// `freezeHistory` and the parent-grant machinery read the host's session manager and stay host-side;
// grants are resident-only.
import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { textTokens } from "./config.ts";
import { isRecord } from "./identity.ts";
import { hashEntries, sourceRole, sourceText } from "./notes.ts";
import type { SessionRecord } from "./records.ts";

/** A frozen snapshot of one branch, taken by the host at the trust boundary and passed in whole. */
export interface HistorySnapshot {
	sessionId: string;
	leafId: string | null;
	/** Cursor identity uses hashEntries(entries), including for hosts whose checkpoint hash is JCS. */
	scopeHash: string;
	entries: readonly SessionRecord[];
}

export const historyQuerySchema = Type.Object(
	{
		operation: Type.Union([Type.Literal("search"), Type.Literal("read")]),
		query: Type.Optional(Type.String({ maxLength: 1000 })),
		entryId: Type.Optional(Type.String({ maxLength: 64 })),
		cursor: Type.Optional(
			Type.String({
				maxLength: 2000,
				description: "Continuation cursor. Repeat the original operation, query, entryId and grantId unchanged.",
			}),
		),
		grantId: Type.Optional(Type.String({ maxLength: 128 })),
	},
	{ additionalProperties: false },
);
export type HistoryQuery = Static<typeof historyQuerySchema>;
export interface HistoryExcerpt {
	entryId: string;
	parentId: string | null;
	role: string;
	/** Index on the branch; search results are ranked, so this is the only chronology signal. */
	position: number;
	offset: number;
	text: string;
}
export interface HistoryPage {
	sessionId: string;
	leafId: string | null;
	scopeHash: string;
	entries: HistoryExcerpt[];
	cursor?: string;
	message?: string;
}

function searchTerms(query: string): string[] {
	const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
	// Chinese questions need smaller literal terms; no model call or vector index is involved.
	const chinese = query.match(/[\p{Script=Han}]{2,}/gu) ?? [];
	return [
		...new Set([
			...words,
			...chinese.flatMap((word) => Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))),
		]),
	].slice(0, 64);
}

function roleWeight(role: string): number {
	return role === "user" ? 3 : role === "assistant" ? 2 : role === "toolResult" || role === "bashExecution" ? 0 : 1;
}

/** The retrieval tool's name on every host; its results copy other records. */
export const HISTORY_TOOL = "context_history";

const isRetrievalOutput = (entry: SessionRecord) =>
	entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === HISTORY_TOOL;

/** Occurrences counted per term when placing an excerpt; a long log can repeat a short term thousands of times. */
const HIT_LIMIT = 4096;
/** Terms count as meeting when they fall within this many characters of the window's first hit. */
const HIT_WINDOW = 400;

/**
 * Where a search excerpt starts: 120 characters before the earliest window that holds the most distinct
 * terms. A single-term query keeps its first hit; a multi-term query finds the line where its terms
 * meet, not the first place one of them appears in a long log.
 */
export function excerptStart(normalized: string, terms: readonly string[]): number {
	const hits: { at: number; term: number }[] = [];
	for (const [term, word] of terms.entries())
		for (
			let at = normalized.indexOf(word), count = 0;
			at >= 0 && count < HIT_LIMIT;
			at = normalized.indexOf(word, at + 1), count++
		)
			hits.push({ at, term });
	if (!hits.length) return 0;
	hits.sort((a, b) => a.at - b.at || a.term - b.term);
	const inWindow = new Map<number, number>();
	let best = hits[0].at;
	let most = 0;
	for (let first = 0, next = 0; first < hits.length; first++) {
		for (; next < hits.length && hits[next].at - hits[first].at <= HIT_WINDOW; next++)
			inWindow.set(hits[next].term, (inWindow.get(hits[next].term) ?? 0) + 1);
		if (inWindow.size > most) {
			most = inWindow.size;
			best = hits[first].at;
		}
		const left = (inWindow.get(hits[first].term) ?? 1) - 1;
		if (left) inWindow.set(hits[first].term, left);
		else inWindow.delete(hits[first].term);
	}
	return Math.max(0, best - 120);
}

/** Branch-scoped literal search and paginated reads. Cursors are bound to the snapshot and query. */
export function queryHistory(snapshot: HistorySnapshot, request: unknown, budgetTokens = 4000): HistoryPage {
	if (!Check(historyQuerySchema, request)) throw new Error("HISTORY_QUERY_INVALID");
	const signature = createHash("sha256")
		// The ranking version is part of the signature: a cursor indexes the sorted candidate list.
		.update(JSON.stringify([request.operation, request.query, request.entryId, "rank-v3"]))
		.digest("hex");
	let index = 0;
	let offset = 0;
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
			!Number.isSafeInteger(cursor.offset) ||
			Number(cursor.index) < 0 ||
			Number(cursor.offset) < 0
		) {
			throw new Error(
				"HISTORY_CURSOR_INVALID: repeat the original operation, query, entryId and grantId with the cursor, or restart the query on the current branch",
			);
		}
		if (cursor.scope !== snapshot.scopeHash) {
			const end = snapshot.entries.findIndex((entry) => entry.id === cursor.leafId);
			const pinned = end >= 0 ? snapshot.entries.slice(0, end + 1) : [];
			if (!pinned.length || hashEntries(pinned) !== cursor.scope)
				throw new Error("HISTORY_CURSOR_INVALID: source is no longer on this branch");
			snapshot = {
				...snapshot,
				leafId: pinned[pinned.length - 1].id,
				entries: pinned,
				scopeHash: hashEntries(pinned),
			};
		}
		index = Number(cursor.index);
		offset = Number(cursor.offset);
	}
	const terms = searchTerms(request.query ?? "");
	if (request.operation === "search" && !terms.length)
		throw new Error("HISTORY_QUERY_REQUIRED: supply search keywords or read an entry ID");
	if (request.operation === "read" && !request.entryId) throw new Error("HISTORY_ENTRY_REQUIRED");
	// Ranking: more matched terms first; among equals, conversation turns before tool output, then newest
	// first. Tool results are typically the longest entries and would otherwise fill the page with an early file dump.
	const candidates = snapshot.entries
		.flatMap((entry, position) => {
			const text = sourceText(entry);
			if (!text) return [];
			if (request.operation === "read")
				return entry.id === request.entryId ? [{ entry, text, score: 1, weight: 0, position }] : [];
			// Earlier results would answer later searches with copies of themselves; a read by ID still works.
			if (isRetrievalOutput(entry)) return [];
			const normalized = text.toLocaleLowerCase();
			const score = terms.reduce(
				(total, term) => total + (entry.id === term ? 10 : normalized.includes(term) ? 1 : 0),
				0,
			);
			return score ? [{ entry, text, score, weight: roleWeight(sourceRole(entry)), position }] : [];
		})
		.sort((a, b) => b.score - a.score || b.weight - a.weight || b.position - a.position);
	if (request.operation === "read" && candidates.length === 0)
		throw new Error("HISTORY_SCOPE_DENIED: entry is not in this readable scope");
	const page: HistoryPage = {
		sessionId: snapshot.sessionId,
		leafId: snapshot.leafId,
		scopeHash: snapshot.scopeHash,
		entries: [],
	};
	let remaining = Math.max(512, Math.min(4000, budgetTokens)) - 350;
	for (; index < candidates.length; index++) {
		const { entry, text, position } = candidates[index];
		// Search returns short hit-centered excerpts. Read returns the complete source across pages.
		let start = offset;
		if (request.operation === "search") start = excerptStart(text.toLocaleLowerCase(), terms);
		const charLimit = request.operation === "search" ? 1400 : remaining * 2;
		let excerpt = text.slice(start, start + charLimit);
		while (textTokens(JSON.stringify(excerpt)) + 100 > remaining && excerpt.length)
			excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.8));
		if (!excerpt) break;
		page.entries.push({
			entryId: entry.id,
			parentId: entry.parentId,
			role: sourceRole(entry),
			position,
			offset: start,
			text: excerpt,
		});
		remaining -= textTokens(JSON.stringify(excerpt)) + 100;
		if (request.operation === "read" && start + excerpt.length < text.length) {
			offset = start + excerpt.length;
			break;
		}
		offset = 0;
		if (remaining < 250) {
			index++;
			break;
		}
	}
	if (index < candidates.length)
		page.cursor = Buffer.from(
			JSON.stringify({
				sessionId: snapshot.sessionId,
				leafId: snapshot.leafId,
				scope: snapshot.scopeHash,
				signature,
				index,
				offset,
			}),
		).toString("base64url");
	if (!page.entries.length)
		page.message = "No matching evidence in this authorized branch. Do not infer missing history.";
	return page;
}
