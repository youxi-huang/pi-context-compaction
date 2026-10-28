import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { contextPressurePlan } from "../packages/compaction-core/src/context-pressure.ts";

const usage = "Usage: node scripts/context-memory-pressure-profile.mjs --context <tokens> --output <tokens> [--input <tokens>]";

/** Configuration fragments only. Never read or rewrite a user's host settings or model metadata. */
export function pressureProfile(limits) {
	const plan = contextPressurePlan(limits);
	const { triggerTokens, keepRecentTokens } = plan;
	const hasInput = limits.inputLimit !== undefined;
	return {
		limits,
		plan,
		pi: {
			settings: { compaction: { enabled: true, reserveTokens: limits.contextWindow - triggerTokens, keepRecentTokens } },
			slice: { compactAt: triggerTokens, keepRecentTokens },
		},
		opencode: {
			version: "1.19.4",
			status: hasInput ? "supported" : "needs-input-limit",
			nativeTriggerTokens: hasInput ? triggerTokens : limits.contextWindow - limits.maxOutputTokens,
			config: {
				compaction: {
					auto: true,
					prune: false,
					preserve_recent_tokens: keepRecentTokens,
					...(hasInput ? { reserved: limits.inputLimit - triggerTokens } : {}),
				},
			},
			...(!hasInput ? { warning: "OpenCode 1.19.4 ignores reserved without limit.input. Verify provider metadata; this fragment does not implement the target trigger. Do not invent an input limit." } : {}),
		},
		dsh: {
			version: "0.2.1-rc.3",
			config: {
				thresholdRatio: 0.75,
				headroomTokens: limits.contextWindow - limits.maxOutputTokens - triggerTokens,
				retainTokens: keepRecentTokens,
				// DSH otherwise uses headroom as its summary output cap. Keep the two budgets separate.
				maxTokens: Math.min(8192, limits.maxOutputTokens),
			},
		},
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const { values } = parseArgs({ options: { context: { type: "string" }, output: { type: "string" }, input: { type: "string" }, help: { type: "boolean" } } });
		if (values.help) console.log(usage);
		else {
			const limits = {
				contextWindow: Number(values.context),
				maxOutputTokens: Number(values.output),
				...(values.input === undefined ? {} : { inputLimit: Number(values.input) }),
			};
			console.log(JSON.stringify(pressureProfile(limits), null, 2));
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Invalid capacity arguments");
		console.error(usage);
		process.exitCode = 2;
	}
}
