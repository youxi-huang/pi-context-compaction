import { runEvaluation } from "./run.ts";
import { scriptedTransport } from "./scripted.ts";

const [fixture, arm, rawReplicate, outputDirectory] = process.argv.slice(2);
if (!["F1", "F2", "F3"].includes(fixture) || !["project", "native"].includes(arm) || !outputDirectory)
	throw new Error(
		"Usage: cli.ts F1|F2|F3 project|native replicate absolute-output-directory (offline environment required)",
	);
const result = await runEvaluation({
	fixture: fixture as "F1" | "F2" | "F3",
	arm: arm as "project" | "native",
	replicate: Number(rawReplicate),
	outputDirectory,
	transport: scriptedTransport(),
});
console.log(
	JSON.stringify({
		run: result.id,
		status: result.status,
		report: `${result.directory}/run.json`,
		counts: result.counts,
	}),
);
// Writer artifact review may be unavailable; this is an explicit terminal run result, not a silently repaired sample.
process.exitCode = result.status === "completed" ? 0 : 2;
