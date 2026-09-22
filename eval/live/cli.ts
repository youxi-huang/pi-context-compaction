import { codexAccess } from "./codex.ts";
import { assertExecutionMode } from "./contract.ts";
import { recordStartupEnvironment } from "./environment.ts";
import { runLivePlan } from "./plan.ts";

recordStartupEnvironment();
const [command, outputDirectory, approvalReference, rawJudgeConcurrency, predecessor] = process.argv.slice(2);
assertExecutionMode("live");
if (
	!["execute", "restart-local", "continue-estimated"].includes(command) ||
	!outputDirectory ||
	!approvalReference ||
	(command !== "execute" ? !predecessor : Boolean(predecessor))
)
	throw new Error(
		"Usage: live/cli.ts execute|restart-local|continue-estimated absolute-artifact-directory approval-reference [judge-concurrency:2|4] [predecessor-diagnostic.json for restart-local] (explicit live environment required)",
	);
const result = await runLivePlan({
	outputDirectory,
	restartFrom: command !== "execute" ? predecessor : undefined,
	continueRemaining: command === "continue-estimated",
	approvalReference,
	judgeConcurrency: rawJudgeConcurrency === undefined ? 2 : (Number(rawJudgeConcurrency) as 2 | 4),
	transport: { mode: "live", access: codexAccess, allowEstimatedUsage: command === "continue-estimated" },
});
console.log(
	JSON.stringify({ status: result.status, directory: result.directory, realModelCalls: result.realModelCalls }),
);
process.exitCode = result.status === "finished" ? 0 : 2;
