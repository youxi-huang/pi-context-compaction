import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RunOptions, runEvaluation } from "./run.ts";
import type { RunResult, Transport } from "./types.ts";

export interface PlanOptions {
	fixtures: RunOptions["fixture"][];
	replicates: number;
	outputDirectory: string;
	totalCalls: number;
	timeoutMs: number;
	transportFactory: () => Transport;
	writerReviewer?: RunOptions["writerReviewer"];
	model?: RunOptions["model"];
	thinkingLevel?: RunOptions["thinkingLevel"];
}
/** Sequential paired order; every scheduled run receives a fresh transport and rebuilds its full chain. */
export async function runPlan(options: PlanOptions) {
	if (
		!Number.isSafeInteger(options.replicates) ||
		options.replicates < 1 ||
		!Number.isSafeInteger(options.totalCalls) ||
		options.totalCalls < 1
	)
		throw new Error("EVAL_PLAN_BUDGET_REQUIRED");
	mkdirSync(options.outputDirectory, { recursive: true });
	const schedule = options.fixtures.flatMap((fixture, index) =>
		Array.from({ length: options.replicates }, (_, replicate) => {
			const arms =
				(index + replicate) % 2 === 0 ? (["project", "native"] as const) : (["native", "project"] as const);
			return arms.map((arm) => ({ fixture, arm, replicate: replicate + 1 }));
		}).flat(),
	);
	const runs: RunResult[] = [];
	const unstarted: { fixture: string; arm: string; replicate: number; reason: string }[] = [];
	const deadline = performance.now() + options.timeoutMs;
	let used = 0;
	for (const item of schedule) {
		if (used >= options.totalCalls || performance.now() >= deadline) {
			unstarted.push({ ...item, reason: used >= options.totalCalls ? "EVAL_PLAN_CALL_LIMIT" : "EVAL_PLAN_TIMEOUT" });
			continue;
		}
		const run = await runEvaluation({
			...item,
			outputDirectory: options.outputDirectory,
			transport: options.transportFactory(),
			writerReviewer: options.writerReviewer,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			maxCalls: options.totalCalls - used,
			timeoutMs: Math.max(1, deadline - performance.now()),
		});
		runs.push(run);
		used += run.counts.providerCalls;
	}
	const exhausted =
		unstarted.length > 0 ||
		runs.some(
			(run) =>
				run.checkpoints.some((c) => /EVAL_RUN_CALL_LIMIT|EVAL_RUN_TIMEOUT/.test(c.error ?? "")) ||
				run.probes.some((p) => /EVAL_RUN_CALL_LIMIT|EVAL_RUN_TIMEOUT/.test(p.error ?? "")),
		);
	const result = {
		mode: "offline-scripted",
		status: exhausted ? "incomplete-budget" : "finished",
		schedule,
		plannedRuns: schedule.length,
		attemptedRuns: runs.length,
		fullyCompletedRuns: runs.filter((run) => run.status === "completed").length,
		providerCalls: used,
		realModelCalls: 0,
		budget: { totalCalls: options.totalCalls, timeoutMs: options.timeoutMs },
		runs: runs.map((run) => ({
			id: run.id,
			status: run.status,
			counts: run.counts,
			report: join(run.directory, "run.json"),
		})),
		unstarted,
	};
	writeFileSync(join(options.outputDirectory, "plan.json"), JSON.stringify(result, null, 2) + "\n");
	writeFileSync(
		join(options.outputDirectory, "plan.md"),
		`# Scripted plan\n\nStatus: ${result.status}. Planned runs ${result.plannedRuns}; attempted ${result.attemptedRuns}; fully completed ${result.fullyCompletedRuns}; unstarted ${unstarted.length}.\n\nCalls ${used}/${options.totalCalls}; real model calls 0. Failure samples are retained, never replaced.\n`,
	);
	return result;
}
