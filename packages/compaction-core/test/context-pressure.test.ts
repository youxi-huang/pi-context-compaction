import { describe, expect, it } from "vitest";
import { contextPressurePlan, preparationStartTokens } from "../src/context-pressure.ts";

describe("opt-in context pressure plan", () => {
	it("gives a 200k route room for output, preparation and a recent tail", () => {
		expect(contextPressurePlan({ contextWindow: 200_000, maxOutputTokens: 32_000 })).toEqual({
			inputCeiling: 168_000,
			headroomTokens: 8192,
			triggerTokens: 150_000,
			prepareTokens: 131_250,
			keepRecentTokens: 15_000,
		});
	});
	it("uses the tighter of input and combined limits without reserving output twice", () => {
		expect(
			contextPressurePlan({ contextWindow: 200_000, maxOutputTokens: 32_000, inputLimit: 160_000 }),
		).toMatchObject({ inputCeiling: 160_000, triggerTokens: 150_000 });
		expect(
			contextPressurePlan({ contextWindow: 200_000, maxOutputTokens: 32_000, inputLimit: 120_000 }),
		).toMatchObject({ inputCeiling: 120_000, triggerTokens: 111_808 });
		expect(
			contextPressurePlan({ contextWindow: 200_000, maxOutputTokens: 64_000, inputLimit: 200_000 }),
		).toMatchObject({ inputCeiling: 136_000, triggerTokens: 127_808 });
	});
	it("keeps headroom and useful retention across 128k, 200k and larger windows", () => {
		for (const contextWindow of [128_000, 200_000, 262_144, 1_000_000]) {
			for (const maxOutputTokens of [4096, 32_000, 64_000]) {
				for (const inputLimit of [undefined, Math.floor(contextWindow * 0.6), contextWindow]) {
					const plan = contextPressurePlan({ contextWindow, maxOutputTokens, inputLimit });
					expect(plan.triggerTokens + maxOutputTokens + plan.headroomTokens).toBeLessThanOrEqual(contextWindow);
					expect(plan.triggerTokens + plan.headroomTokens).toBeLessThanOrEqual(inputLimit ?? contextWindow);
					expect(plan.keepRecentTokens).toBeGreaterThan(0);
					expect(plan.keepRecentTokens).toBeLessThan(plan.prepareTokens);
					expect(plan.prepareTokens).toBeLessThan(plan.triggerTokens);
				}
			}
		}
	});
	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid metadata %s instead of assuming 200k",
		(value) => {
			const valid = { contextWindow: 200_000, maxOutputTokens: 32_000 };
			for (const key of ["contextWindow", "maxOutputTokens", "inputLimit"] as const) {
				expect(() => contextPressurePlan({ ...valid, [key]: value })).toThrow("CONTEXT_CAPACITY");
			}
		},
	);
	it("rejects contradictory limits or a window with no useful compaction budget", () => {
		expect(() => contextPressurePlan({ contextWindow: 200_000, maxOutputTokens: 200_000 })).toThrow(
			"CONTEXT_CAPACITY",
		);
		expect(() => contextPressurePlan({ contextWindow: 128_000, maxOutputTokens: 8192, inputLimit: 200_000 })).toThrow(
			"CONTEXT_CAPACITY",
		);
		expect(() => contextPressurePlan({ contextWindow: 16_384, maxOutputTokens: 8192 })).toThrow("CONTEXT_CAPACITY");
	});
	it("bounds the preparation lead and never returns a negative start", () => {
		expect(preparationStartTokens(400_000)).toBe(367_232);
		expect(preparationStartTokens(40_000)).toBe(31_808);
		expect(preparationStartTokens(4096)).toBe(0);
		expect(() => preparationStartTokens(Number.NaN)).toThrow("CONTEXT_CAPACITY");
	});
});
