// Cloned from the pure budget blocks of packages/coding-agent/test/context-memory-budget.test.ts
// (the tier table, fixed/cap/floor selection and stored-limit tampering) and the memoryBudget
// assertions of context-memory.test.ts ("configuration validates the new budgets and compactAt
// lowers the threshold"), retargeted at the core copy. The resident tests keep running against the
// resident copy untouched; this file imports nothing from Pi. `readMemoryConfig`'s settings-file
// coverage stays host-side with the function.
import { describe, expect, it } from "vitest";
import { type BudgetModel, memoryBudget, selectNoteBudget, storedNoteLimit, textTokens } from "../src/config.ts";

const model: BudgetModel = { id: "memory-test", contextWindow: 128_000, maxTokens: 4096 };

describe("compaction core: tiered note budgets", () => {
	it.each([
		[0, 1, 3000, 4000],
		[50_000, 1, 3000, 4000],
		[80_000, 1, 3000, 4000],
		[80_001, 2, 4000, 5000],
		[200_000, 2, 4000, 5000],
		[200_001, 3, 5000, 6000],
		[250_000, 3, 5000, 6000],
		[400_000, 3, 5000, 6000],
		[400_001, 4, 6000, 8000],
		[1_000_000, 4, 6000, 8000],
	])("source %i selects tier %i with %i/%i budget", (size, tier, base, hard) => {
		expect(selectNoteBudget({}, 400_000, size)).toMatchObject({
			mode: "tiered",
			tier,
			baseTokens: base,
			hardTokens: hard,
		});
	});

	it("explicit settings remain fixed, small windows cap tiers, and the floor follows actual note size rather than historical tier", () => {
		expect(selectNoteBudget({ noteTokens: 2000 }, 400_000, 500_000, 7000)).toMatchObject({
			mode: "fixed",
			tier: 0,
			baseTokens: 2000,
			hardTokens: 2000,
		});
		expect(selectNoteBudget({}, 10_000, 250_000, 7000)).toMatchObject({ baseTokens: 1500, hardTokens: 1500 });
		expect(selectNoteBudget({}, 2048, 250_000)).toMatchObject({ baseTokens: 500, hardTokens: 500 });
		expect(selectNoteBudget({}, 400_000, 100, 7000)).toMatchObject({ tier: 1, baseTokens: 6300, hardTokens: 7000 });
		expect(selectNoteBudget({}, 400_000, 100, 3100)).toMatchObject({ baseTokens: 3000, hardTokens: 4000 });
		expect(selectNoteBudget({ noteTokens: 30_000 }, 400_000, 100).hardTokens).toBe(8000);
	});

	it("rejects invalid budget measurements before the writer is invoked", () => {
		for (const invalid of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => selectNoteBudget({}, 400_000, invalid)).toThrow("CONTEXT_CONFIG");
			expect(() => selectNoteBudget({}, 400_000, 100, invalid)).toThrow("CONTEXT_CONFIG");
		}
	});

	it("stored limits reject tampering and legacy checkpoints keep 6000", () => {
		expect(storedNoteLimit(undefined)).toBe(6000);
		const policy = selectNoteBudget({}, 400_000, 500_000);
		expect(storedNoteLimit(policy)).toBe(policy.hardTokens);
		for (const mutation of [
			{ hardTokens: 9000 },
			{ baseTokens: 9000 },
			{ version: 2 },
			{ tier: 0 },
			{ sourceTokens: -1 },
			{ hardTokens: "8000" },
		])
			expect(() => storedNoteLimit({ ...policy, ...mutation })).toThrow("CONTEXT_NOTE_VERSION");
	});
});

describe("compaction core: memory budget and token estimate", () => {
	it("configuration validates the new budgets and compactAt lowers the threshold", () => {
		const config = { keepRecentTokens: 4000, noteTokens: 2000, compactAt: 0.5 };
		const budget = memoryBudget(model, config);
		expect(budget.threshold).toBe(64_000);
		expect(budget.noteTokens).toBe(2000);
		expect(budget.recentTokens).toBe(4000);
		expect(memoryBudget(model, { ...config, compactAt: 30_000 }).threshold).toBe(30_000);
		expect(memoryBudget({ ...model, contextWindow: 19_000 }).noteTokens).toBe(500);
		expect(memoryBudget(model).recentTokens).toBe(0);
		expect(memoryBudget(model).noteTokens).toBe(3000);
	});

	it("refuses a window that leaves no usable input allowance", () => {
		expect(() => memoryBudget({ ...model, contextWindow: 4095 })).toThrow("CONTEXT_CAPACITY");
		expect(() => memoryBudget({ ...model, contextWindow: 16_000, maxTokens: 16_384 })).toThrow("CONTEXT_CAPACITY");
	});

	it("estimates text conservatively at three UTF-8 bytes per token", () => {
		expect(textTokens("")).toBe(0);
		expect(textTokens("abc")).toBe(1);
		expect(textTokens("abcd")).toBe(2);
		expect(textTokens("界".repeat(10))).toBe(10);
	});
});
