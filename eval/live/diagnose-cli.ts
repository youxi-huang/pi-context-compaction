import { diagnoseOnce } from "./diagnose.ts";

const [priorPlan, approvalReference] = process.argv.slice(2);
if (!priorPlan || !approvalReference)
	throw new Error("Usage: diagnose-cli.ts absolute-prior-plan.json authorization-reference");
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
