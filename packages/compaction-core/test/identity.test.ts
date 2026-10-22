// Cloned from packages/coding-agent/test/context-memory-validation.test.ts (the identity-focused
// block), retargeted at the core copy of identity.ts. The resident tests keep running against the
// resident copy untouched; this file imports nothing from Pi.
import { describe, expect, it } from "vitest";
import { hashEntries, hashEntryPrefixes } from "../src/identity.ts";

describe("compaction core: byte-equivalent single-pass prefix hashes", () => {
	it("matches every prefix byte rule, including empty, Unicode, escapes, nested values and omitted properties", () => {
		const entries: readonly unknown[] = [
			{ text: 'Synthetic 中文 / emoji 🐙 / \n / " / \\' },
			{ nested: { value: null, numbers: [0, -0, 1.5], omitted: undefined } },
			["synthetic", null, { nested: [true, false] }],
			{ second: "b", first: "a" },
		];
		const lengths = Array.from({ length: entries.length + 1 }, (_, index) => index);
		const hashes = hashEntryPrefixes(entries, lengths);
		for (const length of lengths) expect(hashes.get(length)).toBe(hashEntries(entries.slice(0, length)));
		expect(hashEntryPrefixes([], [0]).get(0)).toBe(hashEntries([]));
	});
	it("serializes each required entry once for unordered duplicate boundaries, and omits a later tail", () => {
		const calls = [0, 0, 0, 0];
		const entries = calls.map((_, index) => ({
			toJSON() {
				calls[index]++;
				return { index };
			},
		}));
		const hashes = hashEntryPrefixes(entries, [3, 0, 1, 2, 3, 0]);
		expect(calls).toEqual([1, 1, 1, 0]);
		for (const length of [0, 1, 2, 3])
			expect(hashes.get(length)).toBe(hashEntries(Array.from({ length }, (_, index) => ({ index }))));
		expect(hashEntryPrefixes(entries, []).size).toBe(0);
		expect(calls).toEqual([1, 1, 1, 0]);
	});
	it.each([-1, 0.5, 3, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid boundary %s", (length) => {
		expect(() => hashEntryPrefixes([{}, {}], [length])).toThrow("CONTEXT_SOURCE_PREFIX");
	});
});
