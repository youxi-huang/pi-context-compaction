import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runEvaluation } from "../runner/run.ts";
import { codexAccess, codexTransport, lunaModel } from "./codex.ts";
import { assertExecutionMode, BUDGET_VERSION, MEASUREMENT_VERSION, schedule } from "./contract.ts";
import { recordStartupEnvironment } from "./environment.ts";
import { Ledger } from "./ledger.ts";
import { claimRestart, inheritRestart, loadRestart } from "./restart.ts";

recordStartupEnvironment();
assertExecutionMode("live");
const [predecessor, directory, approvalReference] = process.argv.slice(2);
if (!predecessor || !directory || !isAbsolute(directory) || !approvalReference)
	throw new Error("EVAL_MINIMAL_ARGUMENTS_REQUIRED");
const prior = loadRestart(predecessor, true);
claimRestart(prior, approvalReference);
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, "owner.json"), JSON.stringify({ approvalReference, at: new Date().toISOString() }), {
	flag: "wx",
});
const ledger = new Ledger((event) =>
	appendFileSync(join(directory, "budget-events.jsonl"), JSON.stringify(event) + "\n"),
);
const global = ledger.group("global", prior.globalLimits),
	baseline = ledger.group("baseline", prior.baselineLimits);
inheritRestart(ledger, global, baseline, prior);
const slot = schedule().find((s) => s.fixture === "F2" && s.arm === "project")!;
const local = ledger.group("minimal-daily", { ...slot.limits, calls: 8, milliseconds: 600000 });
const contract = {
	version: "minimal-daily.1",
	budgetVersion: BUDGET_VERSION,
	approvalReference,
	model: "openai-codex/gpt-5.6-luna",
	thinking: "max",
	fixture: "F2",
	arm: "project",
	checkpoints: ["F2-cp1", "F2-cp2"],
	checks:
		"One existing continuation probe per checkpoint: audit state retained, approved staging action executed, production untouched; local assertions, no judge.",
	maxRequests: 8,
	maxWallMs: 600000,
	writerRequestTimeoutMs: 600000,
	taskRequestTimeoutMs: 120000,
	taskRequestsPerGroup: 2,
	maxActions: 2,
	maxToolRounds: 3,
	probeOutputTokens: 8192,
	automaticRetries: 0,
	capMode: "local-post-response",
	usage: "actual or explicitly estimated",
	predecessor,
	originalStart: prior.originalStart,
	priorRequests: prior.quota.sent,
	oldUnstartedRuns: { count: 16, disposition: "closed-unstarted-by-user-scope-reduction" },
};
writeFileSync(join(directory, "contract.json"), JSON.stringify(contract, null, 2) + "\n");
const transport = codexTransport({
	mode: "live",
	ledger,
	groups: () => [global, baseline, local],
	access: codexAccess,
	allowEstimatedUsage: true,
	writerTimeoutMs: 600000,
});
const started = performance.now();
try {
	const run = await runEvaluation({
		fixture: "F2",
		arm: "project",
		replicate: 1,
		outputDirectory: directory,
		transport,
		model: lunaModel(),
		thinkingLevel: "max",
		maxCalls: 8,
		timeoutMs: 600000,
		measurementVersion: MEASUREMENT_VERSION,
		minimalDaily: true,
	});
	writeFileSync(
		join(directory, "result.json"),
		JSON.stringify(
			{
				contract,
				elapsedMs: performance.now() - started,
				status: run.status,
				run: join(run.directory, "run.json"),
				newRequests: local.sent,
				cumulativeRequests: global.sent,
				ledger: ledger.snapshot(),
			},
			null,
			2,
		) + "\n",
	);
	console.log(
		JSON.stringify({ status: run.status, directory, newRequests: local.sent, cumulativeRequests: global.sent }),
	);
	process.exitCode = run.status === "completed" ? 0 : 2;
} catch (error) {
	const reason = error instanceof Error ? error.message : "EVAL_MINIMAL_FAILED";
	writeFileSync(
		join(directory, "result.json"),
		JSON.stringify(
			{
				contract,
				elapsedMs: performance.now() - started,
				status: "failed",
				error: reason,
				newRequests: local.sent,
				cumulativeRequests: global.sent,
				ledger: ledger.snapshot(),
			},
			null,
			2,
		) + "\n",
	);
	throw error;
}
