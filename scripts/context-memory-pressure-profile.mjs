import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const usage = "Usage: node scripts/context-memory-pressure-profile.mjs --context <tokens> --output <tokens> [--input <tokens>] [--model <provider/id>]";
const count = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;

/**
 * Native compaction fragments from verified route limits. Missing metadata is never guessed, nothing is written,
 * and there is no special case for 200k. The 75% target, the 8,192-token margin below the input ceiling and the
 * 15,000-token recent budget are starting values, not measured optima.
 */
export function pressureProfile({ contextWindow, maxOutputTokens, inputLimit, model }) {
	if (!count(contextWindow, 4096) || !count(maxOutputTokens, 1) || maxOutputTokens >= contextWindow || (inputLimit !== undefined && (!count(inputLimit, 1) || inputLimit > contextWindow))) {
		throw new Error("CONTEXT_CAPACITY: provide verified context/output limits and a consistent optional input limit");
	}
	const inputCeiling = Math.min(contextWindow - maxOutputTokens, inputLimit ?? contextWindow);
	const targetTokens = Math.floor(Math.min(contextWindow * 0.75, inputCeiling - 8192));
	if (targetTokens < 4096) throw new Error("CONTEXT_CAPACITY: output and margin leave too little usable input");
	const keepRecentTokens = Math.min(15_000, Math.floor(targetTokens * 0.1));
	const pi = { reserveTokens: contextWindow - targetTokens, keepRecentTokens };
	const hasInput = inputLimit !== undefined;
	return {
		targetTokens,
		keepRecentTokens,
		pi: {
			// The preview reads Pi's effective reserveTokens, per-model override first, and prepares below that line.
			settings: { compaction: model === undefined ? pi : { modelOverrides: { [model]: pi } } },
			slice: { keepRecentTokens },
		},
		opencode: {
			version: "1.19.4",
			status: hasInput ? "supported" : "needs-input-limit",
			// Without limit.input, 1.19.4 ignores reserved and compacts at context minus output.
			nativeTriggerTokens: hasInput ? targetTokens : contextWindow - maxOutputTokens,
			config: { compaction: { auto: true, prune: false, preserve_recent_tokens: keepRecentTokens, ...(hasInput ? { reserved: inputLimit - targetTokens } : {}) } },
		},
		dsh: {
			version: "0.2.1-rc.3",
			config: {
				thresholdRatio: 0.75,
				headroomTokens: contextWindow - maxOutputTokens - targetTokens,
				retainTokens: keepRecentTokens,
				// DSH otherwise caps summary output at the headroom. Keep the two budgets separate.
				maxTokens: Math.min(8192, maxOutputTokens),
			},
		},
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const { values } = parseArgs({ options: { context: { type: "string" }, output: { type: "string" }, input: { type: "string" }, model: { type: "string" }, help: { type: "boolean" } } });
		if (values.help) console.log(usage);
		else {
			if (values.model !== undefined && !/^[^/\s]+\/\S+$/.test(values.model)) throw new Error("CONTEXT_CAPACITY: --model takes provider/id");
			const limits = { contextWindow: Number(values.context), maxOutputTokens: Number(values.output), ...(values.input === undefined ? {} : { inputLimit: Number(values.input) }) };
			const profile = pressureProfile({ ...limits, model: values.model });
			console.log(JSON.stringify(profile, null, 2));
			if (profile.opencode.status !== "supported") console.error(`OpenCode 1.19.4 ignores reserved without limit.input: its line stays at ${profile.opencode.nativeTriggerTokens}. Do not invent an input limit.`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Invalid capacity arguments");
		console.error(usage);
		process.exitCode = 2;
	}
}
