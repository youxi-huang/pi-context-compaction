import type { Probe } from "../schema.ts";

export const MEASUREMENT_VERSION = "0.3-measurement.2" as const;
export const BUDGET_VERSION = "0.3-live-budget.4";
export const MODEL_ID = "gpt-5.6-luna";
export function assertExecutionMode(mode: "scripted" | "live"): void {
	if (mode === "scripted") {
		if (process.env.PI_OFFLINE !== "1" || process.env.EVAL_MODEL_CALL_BUDGET !== "0")
			throw new Error("EVAL_STAGE2_OFFLINE_REQUIRED");
	} else if (
		process.env.PI_OFFLINE === "1" ||
		process.env.EVAL_PROVIDER_MODE !== "live" ||
		process.env.EVAL_LIVE_APPROVAL !== BUDGET_VERSION ||
		process.env.EVAL_MODEL_CALL_BUDGET !== "1692"
	)
		throw new Error("EVAL_FINAL_LIVE_APPROVAL_REQUIRED");
}
/** Only the authorized numeric measurement changes; source probes remain byte-identical. */
export function effectiveProbe(probe: Probe, version?: typeof MEASUREMENT_VERSION): Probe {
	const copy = structuredClone(probe);
	if (version && copy.oracle.kind === "continuation") copy.oracle.contract.maxOutputTokens = 8192;
	return copy;
}
export interface Limits {
	calls: number;
	input: number;
	output: number;
	milliseconds: number;
}
export interface Slot {
	fixture: "F1" | "F2" | "F3";
	arm: "project" | "native";
	replicate: number;
	key: string;
	limits: Limits;
}
export function schedule(): Slot[] {
	const input = { F1: [1200000, 2400000], F2: [2000000, 3600000], F3: [1200000, 1800000] };
	const oldOutput = { F1: [60000, 72000], F2: [88000, 108000], F3: [48000, 56000] };
	return (["F1", "F2", "F3"] as const).flatMap((fixture, i) =>
		[1, 2, 3].flatMap((replicate) =>
			((i + replicate - 1) % 2 ? (["native", "project"] as const) : (["project", "native"] as const)).map((arm) => {
				const idx = arm === "project" ? 0 : 1;
				const probes = fixture === "F1" ? 16 : 24;
				const checkpoints = fixture === "F1" ? 2 : fixture === "F2" ? 3 : 1;
				return {
					fixture,
					arm,
					replicate,
					key: `${fixture}-${arm}-r${replicate}`,
					limits: {
						calls: 2 * checkpoints + 4 * probes,
						input: input[fixture][idx],
						output: oldOutput[fixture][idx] + probes * (8192 - 1024),
						milliseconds: (fixture === "F2" ? 60 : 40) * 60000,
					},
				};
			}),
		),
	);
}
export function baselineLimits(): Limits {
	return schedule().reduce(
		(a, s) => ({
			calls: a.calls + s.limits.calls,
			input: a.input + s.limits.input,
			output: a.output + s.limits.output,
			milliseconds: a.milliseconds + s.limits.milliseconds,
		}),
		{ calls: 0, input: 0, output: 0, milliseconds: 0 },
	);
}
export const JUDGE_LIMITS: Limits = { calls: 84, input: 2688000, output: 442368, milliseconds: 84 * 60000 };
export function combinedLimits(): Limits {
	const b = baselineLimits();
	return {
		calls: b.calls + 84,
		input: b.input + 2688000,
		output: b.output + 442368,
		milliseconds: b.milliseconds + JUDGE_LIMITS.milliseconds,
	};
}
