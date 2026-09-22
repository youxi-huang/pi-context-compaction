import { codexAccess } from "./codex.ts";
import { assertExecutionMode } from "./contract.ts";
import { runLivePlan } from "./plan.ts";

const [command, outputDirectory, approvalReference, rawJudgeConcurrency] = process.argv.slice(2);
assertExecutionMode("live");
if (command !== "execute" || !outputDirectory || !approvalReference)
	throw new Error(
		"Usage: live/cli.ts execute absolute-artifact-directory approval-reference [judge-concurrency:2|4] (explicit live environment required)",
	);
const result = await runLivePlan({
	outputDirectory,
	approvalReference,
	judgeConcurrency: rawJudgeConcurrency === undefined ? 2 : (Number(rawJudgeConcurrency) as 2 | 4),
	transport: { mode: "live", access: codexAccess },
});
console.log(
	JSON.stringify({ status: result.status, directory: result.directory, realModelCalls: result.realModelCalls }),
);
process.exitCode = result.status === "finished" ? 0 : 2;
