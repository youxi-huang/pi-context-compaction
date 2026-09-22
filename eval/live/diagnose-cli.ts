import { diagnoseOnce } from "./diagnose.ts";
import { recordStartupEnvironment } from "./environment.ts";

recordStartupEnvironment();
const [priorPlan, approvalReference] = process.argv.slice(2);
if (!priorPlan || !approvalReference)
	throw new Error("Usage: diagnose-cli.ts absolute-prior-plan-or-diagnostic.json authorization-reference");
const result = await diagnoseOnce(priorPlan, approvalReference);
console.log(
	JSON.stringify({
		directory: result.directory,
		status: result.status,
		error: result.error,
		diagnosticRequests: result.diagnosticRequests,
		cumulativeRequests: result.cumulativeRequests,
	}),
);
