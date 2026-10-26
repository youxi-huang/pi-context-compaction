import type { createOpencodeClient } from "@opencode-ai/sdk";
import { z } from "zod";
import type { HistoryQuery } from "../../compaction-core/src/history.ts";
import { readOpenCodeHistory } from "./history.ts";

/** Fields consumed from the public 1.x tool context, without a V2 dependency. */
interface HistoryToolContext {
	sessionID: string;
	messageID: string;
	directory: string;
	abort: AbortSignal;
	ask(input: {
		permission: string;
		patterns: string[];
		always: string[];
		metadata: Record<string, unknown>;
	}): Promise<void>;
}

/** The public 1.x plugin function returns hooks; its tool() helper is an identity function. */
export const SliceHistory = async ({ client }: { client: ReturnType<typeof createOpencodeClient> }) => ({
	tool: {
		context_history: {
			description:
				"Search or read original text from this session's stored history. Results cite native part IDs. Repeat the query with its cursor for more. This tool does not compact history.",
			args: {
				operation: z.enum(["search", "read"]),
				query: z.string().max(1000).optional(),
				entryId: z.string().max(64).optional(),
				cursor: z.string().max(2000).optional(),
			},
			async execute(args: HistoryQuery, context: HistoryToolContext) {
				await context.ask({
					permission: "context_history",
					patterns: ["current-session"],
					always: ["current-session"],
					metadata: {},
				});
				return JSON.stringify(
					await readOpenCodeHistory(
						client,
						context.sessionID,
						context.directory,
						context.messageID,
						args,
						context.abort,
					),
				);
			},
		},
	},
});
