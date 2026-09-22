import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertFrozenInputs, runnerFingerprint } from "../runner/frozen.ts";
import { runEvaluation } from "../runner/run.ts";
import type { RunResult } from "../runner/types.ts";
import { summarize } from "../scorer.ts";
import { json } from "../test-utils.ts";
import { type CodexOptions, codexTransport, lunaModel } from "./codex.ts";
import {
	assertExecutionMode,
	BUDGET_VERSION,
	baselineLimits,
	combinedLimits,
	JUDGE_LIMITS,
	MEASUREMENT_VERSION,
	schedule,
} from "./contract.ts";
import { reviewF3 } from "./judge.ts";
import { Ledger, type Quota } from "./ledger.ts";

export async function runLivePlan(options: {
	outputDirectory: string;
	approvalReference: string;
	transport: Omit<CodexOptions, "ledger" | "groups">;
}) {
	assertExecutionMode(options.transport.mode);
	assertFrozenInputs();
	if (!isAbsolute(options.outputDirectory) || !options.approvalReference.trim())
		throw new Error("EVAL_PLAN_OUTPUT_AND_APPROVAL_REQUIRED");
	const directory = join(options.outputDirectory, `live-plan-${randomUUID()}`);
	mkdirSync(directory, { recursive: true });
	const ledger = new Ledger((event) =>
		appendFileSync(join(directory, "budget-events.jsonl"), JSON.stringify(event) + "\n"),
	);
	const global = ledger.group("global", combinedLimits()),
		baseline = ledger.group("baseline", baselineLimits());
	const slots = schedule(),
		runs: RunResult[] = [],
		unstarted: { key: string; reason: string }[] = [],
		runErrors: { key: string; reason: string }[] = [];
	const reviews: Awaited<ReturnType<typeof reviewF3>>[] = [];
	let phase = "baseline";
	const save = () => {
		const expectedPartial = runs.filter((r) => r.fixture === "F3").length > 0;
		const data = {
			budgetVersion: BUDGET_VERSION,
			measurementVersion: MEASUREMENT_VERSION,
			mode: options.transport.mode,
			approvalReference: options.approvalReference,
			runnerSourceHash: runnerFingerprint(),
			directory,
			status: ledger.fatal
				? "incomplete-budget-or-provider"
				: unstarted.length
					? "incomplete"
					: phase === "finished"
						? "finished"
						: "running",
			phase,
			scope: "18 chains plus option-C writer semantic coverage; unselected observations stay blocked",
			schedule: slots,
			plannedRuns: 18,
			attemptedRuns: runs.length + runErrors.length,
			completedExecutionRuns: runs.filter(
				(r) =>
					r.checkpoints.every((c) => c.status === "committed") &&
					r.probes.filter((p) => p.target === "task").every((p) => p.status === "completed"),
			).length,
			realModelCalls: options.transport.mode === "live" ? global.sent : 0,
			scriptedRequests: options.transport.mode === "scripted" ? global.sent : 0,
			runErrors,
			unstarted,
			runs: runs.map((r) => ({
				id: r.id,
				fixture: r.fixture,
				arm: r.arm,
				replicate: r.replicate,
				status: r.status,
				counts: r.counts,
				report: join(r.directory, "run.json"),
			})),
			writerReview: {
				option: "C",
				plannedSelected: 60,
				totalOriginalObservations: 120,
				expectedPartial,
				completed: reviews.reduce((n, r) => n + (r?.completed ?? 0), 0),
				reports: reviews.map((r) => ({
					run: r?.run,
					selected: r?.selected,
					completed: r?.completed,
					requests: r?.records.length,
				})),
			},
			scores: summarize(runs.flatMap((r) => r.probes.map((p) => p.score))),
			ledger: ledger.snapshot(),
		};
		json(join(directory, "plan.json"), data);
		writeFileSync(
			join(directory, "plan.md"),
			`# Evaluation plan\n\nStatus: ${data.status}. Model: openai-codex/gpt-5.6-luna, thinking max. Contract: ${MEASUREMENT_VERSION}.\n\nPlanned runs 18; attempted ${data.attemptedRuns}; completed task executions ${data.completedExecutionRuns}; unstarted ${unstarted.length}. Provider requests ${global.sent}; real model calls ${data.realModelCalls}.\n\nCap mode: ${ledger.capMode}; ${ledger.fallbackReason ?? "server enforcement not yet established"}. Actual output includes reasoning. Missing usage stops the plan.\n\nF3 selected 60/120 original writer observations; completed ${data.writerReview.completed}. Remaining original observations stay unreviewed; this is an intentionally partial semantic baseline. Failure samples are retained.\n`,
		);
		return data;
	};
	for (const slot of slots) {
		if (ledger.fatal) {
			unstarted.push({ key: slot.key, reason: ledger.fatal });
			continue;
		}
		const runQuota = ledger.group(slot.key, slot.limits),
			checkpoints = new Map<string, Quota>();
		const transport = codexTransport({
			...options.transport,
			ledger,
			groups(request) {
				const groups = [global, baseline, runQuota];
				if (request.purpose === "writer") {
					const key = request.scope?.checkpoint ?? "unknown";
					let q = checkpoints.get(key);
					if (!q) {
						q = ledger.group(`${slot.key}-${key}-writer`, { ...slot.limits, calls: 2 });
						checkpoints.set(key, q);
					}
					groups.push(q);
				}
				return groups;
			},
		});
		try {
			const run = await runEvaluation({
				...slot,
				outputDirectory: directory,
				transport,
				model: lunaModel(),
				thinkingLevel: "max",
				measurementVersion: MEASUREMENT_VERSION,
				maxCalls: slot.limits.calls,
				timeoutMs: slot.limits.milliseconds,
			});
			runs.push(run);
			if (
				[...run.checkpoints, ...run.probes].some((item) =>
					/EVAL_RUN_CALL_LIMIT|EVAL_RUN_TIMEOUT/.test(item.error ?? ""),
				)
			)
				ledger.fatal ??= "EVAL_RUN_BUDGET_EXHAUSTED";
		} catch {
			ledger.fatal ??= "EVAL_RUN_INFRASTRUCTURE_FAILURE";
			runErrors.push({ key: slot.key, reason: ledger.fatal });
		}
		save();
	}
	phase = "judge";
	const judge = ledger.group("judge", JUDGE_LIMITS);
	for (const run of runs.filter((r) => r.fixture === "F3")) {
		if (ledger.fatal) break;
		try {
			reviews.push(await reviewF3(run, { ledger, parents: [global, judge], transport: options.transport }));
		} catch {
			ledger.fatal ??= "EVAL_JUDGE_INFRASTRUCTURE_FAILURE";
		}
		save();
	}
	phase = "finished";
	return save();
}
