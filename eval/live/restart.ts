import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { RunResult } from "../runner/types.ts";
import { baselineLimits, combinedLimits, type Limits } from "./contract.ts";
import { seedQuota } from "./diagnose.ts";
import { Ledger, type Quota } from "./ledger.ts";

interface Predecessor {
	status: string;
	attempt: number;
	cumulativeRequests: number;
	originalStart?: string;
	originalLimits?: Limits;
	restart?: { originalStart: string };
	runs?: { report: string }[];
	unstarted?: unknown[];
	priorPlan: string;
	measurement?: { diagnostics: { httpStatus: number; errorBody: string } };
	ledger: { groups: ReturnType<Quota["snapshot"]>[] };
}
/** Explicit one-time replay from the accepted third diagnostic, retaining all unknown usage. */
export function loadRestart(predecessorFile: string, continueRemaining = false) {
	if (!isAbsolute(predecessorFile)) throw new Error("EVAL_RESTART_ABSOLUTE_PREDECESSOR_REQUIRED");
	const bytes = readFileSync(predecessorFile);
	const prior = JSON.parse(bytes.toString("utf8")) as Predecessor;
	const quota = prior.ledger.groups.find((q) => q.name === (continueRemaining ? "global" : "global-cumulative"));
	if (continueRemaining) {
		if (
			prior.status !== "incomplete-budget-or-provider" ||
			!prior.restart ||
			!prior.runs?.length ||
			!prior.unstarted?.length ||
			!quota
		)
			throw new Error("EVAL_CONTINUATION_PREDECESSOR_MISMATCH");
	} else if (
		prior.status !== "diagnostic-stopped-for-evidence" ||
		prior.attempt !== 3 ||
		prior.cumulativeRequests !== 3 ||
		!quota ||
		quota.sent !== 3 ||
		quota.calls !== 3 ||
		prior.measurement?.diagnostics.httpStatus !== 400 ||
		!prior.measurement.diagnostics.errorBody.includes("Unsupported parameter: max_output_tokens")
	)
		throw new Error("EVAL_RESTART_PREDECESSOR_MISMATCH");
	if (!quota) throw new Error("EVAL_RESTART_PREDECESSOR_MISMATCH");
	const globalLimits = combinedLimits(),
		baseline = baselineLimits();
	for (const field of ["calls", "input", "output", "milliseconds"] as const)
		if (
			(continueRemaining ? (field === "milliseconds" ? globalLimits : quota.limits) : prior.originalLimits)?.[
				field
			] !== globalLimits[field]
		)
			throw new Error("EVAL_RESTART_BUDGET_DRIFT");
	const originalStart = (continueRemaining ? prior.restart?.originalStart : prior.originalStart) ?? "";
	const elapsed = Date.now() - Date.parse(originalStart);
	if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= baseline.milliseconds)
		throw new Error("EVAL_RESTART_ORIGINAL_DEADLINE");
	// Validate every inherited counter before acquiring ownership or sending anything.
	const validation = new Ledger().group("validation", globalLimits);
	seedQuota(validation, quota);
	return {
		predecessorFile,
		predecessorSha256: createHash("sha256").update(bytes).digest("hex"),
		priorPlan: continueRemaining ? predecessorFile : prior.priorPlan,
		originalStart,
		retainedRuns: continueRemaining
			? prior.runs!.map((run) => JSON.parse(readFileSync(run.report, "utf8")) as RunResult)
			: [],
		continueRemaining,
		originalLimits: globalLimits,
		elapsedBeforeRestartMs: elapsed,
		quota,
		globalLimits: { ...globalLimits, milliseconds: globalLimits.milliseconds - elapsed },
		baselineLimits: { ...baseline, milliseconds: baseline.milliseconds - elapsed },
	};
}
export function claimRestart(state: ReturnType<typeof loadRestart>, approvalReference: string) {
	writeFileSync(
		join(dirname(state.predecessorFile), "local-replay-claim.json"),
		JSON.stringify({ approvalReference, predecessorSha256: state.predecessorSha256, at: new Date().toISOString() }) +
			"\n",
		{ flag: "wx", mode: 0o600 },
	);
}
export function inheritRestart(ledger: Ledger, global: Quota, baseline: Quota, state: ReturnType<typeof loadRestart>) {
	seedQuota(global, state.quota);
	// In this authorized continuation all earlier requests were baseline writers.
	seedQuota(baseline, state.quota);
	ledger.fallback("explicitly-authorized-replay-after-parameter-rejection");
	ledger.event({
		type: "inherited-replay-budget",
		predecessor: state.predecessorFile,
		predecessorSha256: state.predecessorSha256,
		originalStart: state.originalStart,
		elapsedBeforeRestartMs: state.elapsedBeforeRestartMs,
		prior: state.quota,
		unknownUsageReservationsRetained: true,
	});
}
