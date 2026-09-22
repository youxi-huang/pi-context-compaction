import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertFrozenInputs, runnerFingerprint } from "../runner/frozen.ts";
import type { CallRecord, RunResult, TransportRequest } from "../runner/types.ts";
import { codexAccess, codexTransport, lunaModel } from "./codex.ts";
import { assertExecutionMode, BUDGET_VERSION, combinedLimits } from "./contract.ts";
import { environmentSnapshot, networkSelfCheck } from "./environment.ts";
import { Ledger, type Quota } from "./ledger.ts";

export function seedQuota(quota: Quota, prior: ReturnType<Quota["snapshot"]>): void {
	for (const field of [
		"calls",
		"sent",
		"knownInput",
		"knownOutput",
		"inputProxy",
		"reservedInput",
		"reservedOutput",
	] as const) {
		if (!Number.isSafeInteger(prior[field]) || prior[field] < 0) throw new Error("EVAL_INVALID_PRIOR_LEDGER");
		quota[field] = prior[field];
	}
}
export async function diagnoseOnce(priorPlanFile: string, approvalReference: string) {
	assertExecutionMode("live");
	assertFrozenInputs();
	const predecessorFile = resolve(priorPlanFile),
		predecessor = JSON.parse(readFileSync(predecessorFile, "utf8"));
	const followup = predecessor.status === "diagnostic-stopped-for-evidence";
	if (
		followup &&
		(predecessor.attempt !== 2 || predecessor.cumulativeRequests !== 2 || predecessor.automaticRetryCount !== 0)
	)
		throw new Error("EVAL_DIAGNOSTIC_PRIOR_STATE_REQUIRED");
	const priorFile = followup ? resolve(predecessor.priorPlan) : predecessorFile;
	const prior = followup ? JSON.parse(readFileSync(priorFile, "utf8")) : predecessor;
	const globalPrior = predecessor.ledger.groups.find(
		(g: { name: string }) => g.name === (followup ? "global-cumulative" : "global"),
	) as ReturnType<Quota["snapshot"]>;
	if (
		prior.status !== "incomplete-budget-or-provider" ||
		!globalPrior ||
		globalPrior.sent !== (followup ? 2 : 1) ||
		!approvalReference.trim()
	)
		throw new Error("EVAL_DIAGNOSTIC_PRIOR_STATE_REQUIRED");
	const priorRun = JSON.parse(readFileSync(prior.runs[0].report, "utf8")) as RunResult;
	const source: CallRecord = priorRun.checkpoints[0].requests[0];
	if (
		priorRun.fixture !== "F1" ||
		priorRun.arm !== "project" ||
		priorRun.replicate !== 1 ||
		source.purpose !== "writer"
	)
		throw new Error("EVAL_DIAGNOSTIC_SLOT_MISMATCH");
	const firstAdmission = String(prior.ledger.events.find((e: { type: string }) => e.type === "admit").at);
	const birth = statSync(dirname(priorFile)).birthtimeMs;
	const originalStart = new Date(
		Math.min(Date.parse(firstAdmission), birth > 0 ? birth : Date.parse(firstAdmission)),
	).toISOString();
	const elapsed = Date.now() - Date.parse(originalStart),
		limits = combinedLimits();
	for (const field of ["calls", "input", "output", "milliseconds"] as const)
		if ((followup ? predecessor.originalLimits : globalPrior.limits)[field] !== limits[field])
			throw new Error("EVAL_DIAGNOSTIC_BUDGET_DRIFT");
	if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= limits.milliseconds)
		throw new Error("EVAL_DIAGNOSTIC_GLOBAL_DEADLINE");
	const directory = join(dirname(priorFile), followup ? "bounded-diagnostic-2" : "bounded-diagnostic");
	mkdirSync(directory, { recursive: true });
	// This authorization allows one request only, even if this CLI is accidentally invoked twice.
	writeFileSync(
		join(directory, "one-request-claim.json"),
		JSON.stringify({
			approvalReference,
			predecessor: predecessorFile,
			priorPlan: priorFile,
			createdAt: new Date().toISOString(),
		}) + "\n",
		{ flag: "wx", mode: 0o600 },
	);
	const ledger = new Ledger((event) =>
		appendFileSync(join(directory, "budget-events.jsonl"), JSON.stringify(event) + "\n"),
	);
	const global = ledger.group("global-cumulative", { ...limits, milliseconds: limits.milliseconds - elapsed });
	seedQuota(global, globalPrior);
	const diagnostic = ledger.group("single-diagnostic-attempt", {
		calls: 1,
		input: 160000,
		output: source.maxTokens,
		milliseconds: 180000,
	});
	ledger.event({
		type: "inherited-global-ledger",
		originalStart,
		originalLimits: limits,
		priorPlan: priorFile,
		prior: globalPrior,
		approvalReference,
	});
	const environment = environmentSnapshot();
	const guarded =
		environment.guards["deny-network"] || environment.guards.PI_OFFLINE || environment.guards["named-fetch-guard"];
	const networkCheck = followup && !guarded ? await networkSelfCheck() : undefined;
	if (followup) {
		writeFileSync(
			join(directory, "network-selfcheck.json"),
			JSON.stringify({ environment, guarded, networkCheck, providerRequests: 0 }, null, 2) + "\n",
		);
		if (guarded || !networkCheck?.ok) {
			const output = {
				status: "diagnostic-stopped-before-provider",
				error: guarded ? "EVAL_NETWORK_GUARD_PRESENT" : "EVAL_NETWORK_SELFCHECK_FAILED",
				budgetVersion: BUDGET_VERSION,
				approvalReference,
				predecessor: predecessorFile,
				priorPlan: priorFile,
				originalStart,
				originalLimits: limits,
				elapsedBeforeDiagnosticMs: elapsed,
				runnerSourceHash: runnerFingerprint(),
				slot: "F1/project/r1/F1-cp1 writer",
				attempt: 3,
				environment,
				networkCheck,
				ledger: ledger.snapshot(),
				diagnosticRequests: 0,
				cumulativeRequests: global.sent,
				automaticRetryCount: 0,
				branchDecision: "network precheck failed; stop without provider request",
			};
			writeFileSync(join(directory, "diagnostic.json"), JSON.stringify(output, null, 2) + "\n");
			return { directory, ...output };
		}
	}
	const transport = codexTransport({ mode: "live", ledger, groups: () => [global, diagnostic], access: codexAccess });
	const request: TransportRequest = {
		purpose: "writer",
		context: structuredClone(source.context),
		model: lunaModel(),
		maxTokens: source.maxTokens,
		reasoning: "max",
		signal: new AbortController().signal,
		providerOptions: source.providerOptions,
		scope: { runId: priorRun.id, fixture: "F1", arm: "project", replicate: 1, checkpoint: "F1-cp1" },
	};
	let error: string | undefined, stopReason: string | undefined;
	try {
		const result = await transport.complete(request);
		stopReason = result.stopReason;
	} catch (e) {
		error = e instanceof Error ? e.message : "EVAL_DIAGNOSTIC_FAILED";
	}
	const output = {
		status: "diagnostic-stopped-for-evidence",
		budgetVersion: BUDGET_VERSION,
		approvalReference,
		priorPlan: priorFile,
		originalStart,
		originalLimits: limits,
		elapsedBeforeDiagnosticMs: elapsed,
		runnerSourceHash: runnerFingerprint(),
		slot: "F1/project/r1/F1-cp1 writer",
		attempt: followup ? 3 : 2,
		environment,
		networkCheck,
		predecessor: predecessorFile,
		requestContextSha256: createHash("sha256").update(JSON.stringify(source.context)).digest("hex"),
		error,
		stopReason,
		measurement: transport.measurement?.(),
		ledger: ledger.snapshot(),
		diagnosticRequests: diagnostic.sent,
		cumulativeRequests: global.sent,
		automaticRetryCount: 0,
		branchDecision: "inspect diagnostic evidence before any continuation",
	};
	writeFileSync(join(directory, "diagnostic.json"), JSON.stringify(output, null, 2) + "\n");
	return { directory, ...output };
}
