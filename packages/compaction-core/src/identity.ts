/** Stable identifiers shared by the resident loader and the small core hooks. */
import { createHash } from "node:crypto";

export const CONTEXT_MEMORY_PATH = "<builtin:context-memory>";
export const CONTEXT_MEMORY_KIND = "pi-context-memory";
export const CONTEXT_NOTE_TYPE = "context-memory-note";
export const CONTEXT_MEMORY_VERSION = 1;
/** `firstKeptEntryId` value meaning that no original message survives the compaction in model context. */
export const CONTEXT_KEEP_NONE = "context-memory:keep-none";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashEntries(entries: readonly unknown[]): string {
	const hash = createHash("sha256");
	for (const entry of entries) hash.update(JSON.stringify(entry)).update("\n");
	return hash.digest("hex");
}

/** Exclusive prefix lengths, using exactly the serialization and newline bytes of hashEntries. */
export function hashEntryPrefixes(
	entries: readonly unknown[],
	prefixLengths: readonly number[],
	onSerializedEntry?: (index: number, serialized: string) => void,
): ReadonlyMap<number, string> {
	const requested = new Set(prefixLengths);
	let last = 0;
	for (const length of requested) {
		if (!Number.isSafeInteger(length) || length < 0 || length > entries.length)
			throw new Error("CONTEXT_SOURCE_PREFIX: invalid source prefix boundary");
		last = Math.max(last, length);
	}
	const result = new Map<number, string>();
	const hash = createHash("sha256");
	if (requested.has(0)) result.set(0, hash.copy().digest("hex"));
	for (let index = 0; index < last; index++) {
		const serialized = JSON.stringify(entries[index]);
		hash.update(serialized).update("\n");
		onSerializedEntry?.(index, serialized);
		if (requested.has(index + 1)) result.set(index + 1, hash.copy().digest("hex"));
	}
	return result;
}
