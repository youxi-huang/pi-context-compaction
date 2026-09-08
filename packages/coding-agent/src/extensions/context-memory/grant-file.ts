import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { loadEntriesFromFile, type SessionEntry } from "../../core/session-manager.ts";
import {
	grantedHistory,
	type HistoryGrant,
	historyGrantRecord,
	registerHistoryGrantReader,
	revokeHistoryGrant,
} from "./history.ts";
import { hashEntries } from "./identity.ts";
import { currentProcessIdentity, isProcessIdentityAlive } from "./lease.ts";

const id = Type.String({ minLength: 1, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const manifestSchema = Type.Object({
	version: Type.Literal(1),
	grant: Type.Object({
		grantId: id,
		parentSessionId: id,
		parentLeafId: Type.Union([id, Type.Null()]),
		childSessionId: id,
		allowedEntryIds: Type.Array(id, { minItems: 1, maxItems: 100_000, uniqueItems: true }),
		scopeHash: digest,
	}),
	issuer: Type.Object({
		pid: Type.Integer({ minimum: 1 }),
		processStart: id,
		bootId: Type.String({ minLength: 1, maxLength: 512 }),
	}),
	parentSessionFile: Type.String({ minLength: 1, maxLength: 8192 }),
	entryHashes: Type.Array(Type.Tuple([id, digest]), { minItems: 1, maxItems: 100_000 }),
});
type GrantManifest = Static<typeof manifestSchema>;

/** Writes authorization metadata only. Original conversation text remains in the parent's JSONL. */
export function saveHistoryGrant(grantId: string, directory: string): string {
	const scope = historyGrantRecord(grantId);
	if (!scope?.sourceFile) throw new Error("HISTORY_GRANT_NOT_PERSISTED: parent must have a persisted session");
	grantedHistory(grantId, scope.grant.childSessionId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const file = join(directory, `${grantId}.json`);
	const manifest: GrantManifest = {
		version: 1,
		grant: { ...scope.grant, allowedEntryIds: [...scope.grant.allowedEntryIds] },
		issuer: currentProcessIdentity(),
		parentSessionFile: scope.sourceFile,
		entryHashes: [...scope.entryHashes],
	};
	writeFileSync(file, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
	const previousRevoke = scope.onRevoke;
	scope.onRevoke = () => {
		previousRevoke?.();
		unlinkSync(file);
	};
	return file;
}

/** Host-only adoption. Nothing is auto-restored from a model-provided grantId or a prior child transcript. */
export function adoptHistoryGrant(file: string, childSessionId: string): HistoryGrant {
	const metadata = statSync(file);
	if (
		metadata.size > 16 * 1024 * 1024 ||
		(metadata.mode & 0o077) !== 0 ||
		(process.getuid && metadata.uid !== process.getuid())
	)
		throw new Error("HISTORY_SCOPE_DENIED: grant manifest must be private to its owner");
	const contents = readFileSync(file, "utf8");
	const value: unknown = JSON.parse(contents);
	if (
		!Check(manifestSchema, value) ||
		value.grant.childSessionId !== childSessionId ||
		!isAbsolute(value.parentSessionFile) ||
		!isProcessIdentityAlive(value.issuer)
	)
		throw new Error("HISTORY_SCOPE_DENIED: issuer must be live and the child identity must match");
	const existing = historyGrantRecord(value.grant.grantId);
	if (existing) {
		if (JSON.stringify(existing.grant) !== JSON.stringify(value.grant))
			throw new Error("HISTORY_SCOPE_DENIED: conflicting grant identity");
		grantedHistory(value.grant.grantId, childSessionId);
		return existing.grant;
	}
	const entryHashes = new Map(value.entryHashes);
	if (
		entryHashes.size !== value.grant.allowedEntryIds.length ||
		value.grant.allowedEntryIds.some((entryId) => !entryHashes.has(entryId))
	)
		throw new Error("HISTORY_SCOPE_DENIED: inconsistent grant scope");
	registerHistoryGrantReader({
		grant: value.grant,
		entryHashes,
		read: () => {
			if (!isProcessIdentityAlive(value.issuer) || readFileSync(file, "utf8") !== contents)
				throw new Error("HISTORY_SCOPE_DENIED: issuer ended, revoked or changed this grant");
			const records = loadEntriesFromFile(value.parentSessionFile);
			if (records[0]?.type !== "session" || records[0].id !== value.grant.parentSessionId)
				throw new Error("HISTORY_SCOPE_DENIED: parent identity changed");
			const byId = new Map(
				records
					.filter((entry): entry is SessionEntry => entry.type !== "session")
					.map((entry) => [entry.id, entry]),
			);
			const entries: SessionEntry[] = [];
			const seen = new Set<string>();
			let current = value.grant.parentLeafId;
			while (current) {
				const entry = byId.get(current);
				if (!entry || seen.has(current)) throw new Error("HISTORY_SCOPE_DENIED: broken ancestor chain");
				seen.add(current);
				entries.push(entry);
				current = entry.parentId;
			}
			entries.reverse();
			return {
				sessionId: value.grant.parentSessionId,
				leafId: value.grant.parentLeafId,
				entries,
				scopeHash: hashEntries(entries),
			};
		},
	});
	try {
		grantedHistory(value.grant.grantId, childSessionId);
	} catch (error) {
		revokeHistoryGrant(value.grant.grantId);
		throw error;
	}
	return value.grant;
}
