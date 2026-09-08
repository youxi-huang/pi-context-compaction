import { createHash, randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { ReadonlySessionManager, SessionEntry } from "../../core/session-manager.ts";
import { textTokens } from "./config.ts";
import { isRecord } from "./identity.ts";
import { hashEntries, sourceRole, sourceText } from "./notes.ts";

export interface HistorySnapshot {
	sessionId: string;
	leafId: string | null;
	scopeHash: string;
	entries: readonly SessionEntry[];
}

export function freezeHistory(session: ReadonlySessionManager, leafId = session.getLeafId()): HistorySnapshot {
	if (leafId !== null && !session.getEntry(leafId)) throw new Error("HISTORY_SCOPE_DENIED: unknown branch anchor");
	const entries = structuredClone(leafId === null ? [] : session.getBranch(leafId));
	return { sessionId: session.getSessionId(), leafId, scopeHash: hashEntries(entries), entries };
}

export interface HistoryGrant {
	grantId: string;
	parentSessionId: string;
	parentLeafId: string | null;
	childSessionId: string;
	allowedEntryIds: readonly string[];
	scopeHash: string;
}

export interface GrantedScope {
	grant: HistoryGrant;
	read(): HistorySnapshot;
	sourceFile?: string;
	entryHashes: ReadonlyMap<string, string>;
	onRevoke?: () => void;
}
const grants = new Map<string, GrantedScope>();

/** Host API only: the model cannot choose a source file or expand its allowed entry IDs. */
export function issueHistoryGrant(
	parent: ReadonlySessionManager,
	childSessionId: string,
	allowedEntryIds: readonly string[],
): HistoryGrant {
	const snapshot = freezeHistory(parent);
	const allowed = new Set(allowedEntryIds);
	if (
		!allowed.size ||
		allowed.size !== allowedEntryIds.length ||
		allowedEntryIds.some((id) => !snapshot.entries.some((entry) => entry.id === id))
	) {
		throw new Error("HISTORY_SCOPE_DENIED: grant must be a nonempty subset of the parent's frozen ancestor chain");
	}
	const entries = snapshot.entries.filter((entry) => allowed.has(entry.id));
	const grant: HistoryGrant = Object.freeze({
		grantId: randomUUID(),
		parentSessionId: snapshot.sessionId,
		parentLeafId: snapshot.leafId,
		childSessionId,
		allowedEntryIds: Object.freeze(entries.map((entry) => entry.id)),
		scopeHash: hashEntries(entries),
	});
	grants.set(grant.grantId, {
		grant,
		read: () => freezeHistory(parent, grant.parentLeafId),
		sourceFile: parent.getSessionFile(),
		entryHashes: new Map(entries.map((entry) => [entry.id, hashEntries([entry])])),
	});
	return grant;
}

export function revokeHistoryGrant(grantId: string): void {
	const record = grants.get(grantId);
	grants.delete(grantId);
	record?.onRevoke?.();
}

/** Internal bridge for an explicitly adopted, issuer-validated cross-process manifest. */
export function historyGrantRecord(grantId: string): GrantedScope | undefined {
	return grants.get(grantId);
}
export function registerHistoryGrantReader(scope: GrantedScope): void {
	if (grants.has(scope.grant.grantId)) throw new Error("HISTORY_GRANT_EXISTS");
	grants.set(scope.grant.grantId, scope);
}
export function revokeSessionHistory(sessionId: string): void {
	for (const [id, scope] of grants)
		if (scope.grant.childSessionId === sessionId || scope.grant.parentSessionId === sessionId) revokeHistoryGrant(id);
}

export function grantedHistory(grantId: string, childSessionId: string): HistorySnapshot {
	const scope = grants.get(grantId);
	if (!scope || scope.grant.childSessionId !== childSessionId) {
		throw new Error("HISTORY_SCOPE_DENIED: missing or mismatched host grant");
	}
	let snapshot: HistorySnapshot;
	try {
		snapshot = scope.read();
	} catch {
		throw new Error("HISTORY_SCOPE_DENIED: granted source or issuer is unavailable");
	}
	if (snapshot.sessionId !== scope.grant.parentSessionId || snapshot.leafId !== scope.grant.parentLeafId)
		throw new Error("HISTORY_SCOPE_DENIED: parent snapshot identity changed");
	const entries = snapshot.entries.filter((entry) => scope.entryHashes.has(entry.id));
	if (
		entries.length !== scope.entryHashes.size ||
		entries.some((entry) => hashEntries([entry]) !== scope.entryHashes.get(entry.id)) ||
		hashEntries(entries) !== scope.grant.scopeHash
	) {
		throw new Error("HISTORY_SCOPE_DENIED: granted source was modified or is no longer an ancestor");
	}
	return { ...snapshot, entries, scopeHash: scope.grant.scopeHash };
}

export const historyQuerySchema = Type.Object(
	{
		operation: Type.Union([Type.Literal("search"), Type.Literal("read")]),
		query: Type.Optional(Type.String({ maxLength: 1000 })),
		entryId: Type.Optional(Type.String({ maxLength: 64 })),
		cursor: Type.Optional(Type.String({ maxLength: 2000 })),
		grantId: Type.Optional(Type.String({ maxLength: 128 })),
	},
	{ additionalProperties: false },
);
export type HistoryQuery = Static<typeof historyQuerySchema>;
export interface HistoryExcerpt {
	entryId: string;
	parentId: string | null;
	role: string;
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

/** Branch-scoped literal search and paginated reads. Cursors are bound to the snapshot and query. */
export function queryHistory(snapshot: HistorySnapshot, request: unknown, budgetTokens = 4000): HistoryPage {
	if (!Check(historyQuerySchema, request)) throw new Error("HISTORY_QUERY_INVALID");
	const signature = createHash("sha256")
		.update(JSON.stringify([request.operation, request.query, request.entryId]))
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
			throw new Error("HISTORY_CURSOR_INVALID: restart the query on the current branch");
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
	const candidates = snapshot.entries
		.flatMap((entry) => {
			const text = sourceText(entry);
			if (!text) return [];
			if (request.operation === "read") return entry.id === request.entryId ? [{ entry, text, score: 1 }] : [];
			const normalized = text.toLocaleLowerCase();
			const score = terms.reduce(
				(total, term) => total + (entry.id === term ? 10 : normalized.includes(term) ? 1 : 0),
				0,
			);
			return score ? [{ entry, text, score }] : [];
		})
		.sort((a, b) => b.score - a.score);
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
		const { entry, text } = candidates[index];
		// Search returns short hit-centered excerpts. Read returns the complete source across pages.
		let start = offset;
		if (request.operation === "search") {
			const hits = terms.map((term) => text.toLocaleLowerCase().indexOf(term)).filter((hit) => hit >= 0);
			start = Math.max(0, (hits.length ? Math.min(...hits) : 0) - 120);
		}
		const charLimit = request.operation === "search" ? 1400 : remaining * 2;
		let excerpt = text.slice(start, start + charLimit);
		while (textTokens(JSON.stringify(excerpt)) + 100 > remaining && excerpt.length)
			excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.8));
		if (!excerpt) break;
		page.entries.push({
			entryId: entry.id,
			parentId: entry.parentId,
			role: sourceRole(entry),
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
