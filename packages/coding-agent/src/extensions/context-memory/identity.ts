/** Stable identifiers shared by the resident loader and the small core hooks. */
import { createHash } from "node:crypto";

export const CONTEXT_MEMORY_PATH = "<builtin:context-memory>";
export const CONTEXT_MEMORY_KIND = "pi-context-memory";
export const CONTEXT_NOTE_TYPE = "context-memory-note";
export const CONTEXT_MEMORY_VERSION = 1;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashEntries(entries: readonly unknown[]): string {
	const hash = createHash("sha256");
	for (const entry of entries) hash.update(JSON.stringify(entry)).update("\n");
	return hash.digest("hex");
}
