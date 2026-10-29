import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readDshHistory } from "./history.ts";

export const name = "slice-history";
export const inject = ["sessions", "sessionPersistence", "tools"];

/** Retrieval only: does not provide ctx.compaction or register request/summary hooks. */
export function apply(ctx: Context) {
	if (ctx.tools.get("context_history")) throw new Error("SLICE_TOOL_CONFLICT: context_history already registered");
	ctx.tools.register(
		defineTool({
			name: "context_history",
			description:
				"Search or read original text in this session's durable history. Native summaries drop exact values, quotes and timestamps: search here before answering that an earlier detail is unknown. Use native event IDs and repeat the query with its cursor for more. No other sessions are accessible. This tool does not compact history.",
			parameters: {
				operation: { type: "string", required: true, enum: ["search", "read"] },
				query: { type: "string" },
				entryId: { type: "string" },
				cursor: { type: "string" },
			},
			output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
			async execute(args, exec) {
				if (!exec.agent) throw new Error("HISTORY_SCOPE_DENIED: missing calling agent");
				return JSON.stringify(
					await readDshHistory(ctx.sessions, ctx.sessionPersistence, exec.agent.session, args, exec.signal),
				);
			},
		}),
	);
}
