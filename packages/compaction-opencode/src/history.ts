import type { createOpencodeClient } from "@opencode-ai/sdk";
import { queryHistory } from "../../compaction-core/src/history.ts";
import { openCodeHistorySnapshot } from "./codec.ts";

export async function readOpenCodeHistory(
	client: Pick<ReturnType<typeof createOpencodeClient>, "session">,
	sessionId: string,
	directory: string,
	beforeMessageId: string,
	request: unknown,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const scope = { path: { id: sessionId }, query: { directory }, signal, throwOnError: true as const };
	const { data: session } = await client.session.get(scope);
	if (!session || session.id !== sessionId || session.parentID)
		throw new Error("HISTORY_SCOPE_DENIED: only the current non-forked session is supported");
	// In the pinned 1.x SDK omitting limit requests the complete stored history, not the model window.
	const { data: messages } = await client.session.messages(scope);
	signal.throwIfAborted();
	if (!messages) throw new Error("HISTORY_SOURCE_INVALID: missing native history");
	const boundary = messages.findIndex(({ info }) => info.id === beforeMessageId && info.sessionID === sessionId);
	if (boundary < 0) throw new Error("HISTORY_SOURCE_INVALID: calling message is missing from native history");
	// Exclude this in-flight assistant message: its parts may still change while this tool runs.
	return queryHistory(openCodeHistorySnapshot(sessionId, messages.slice(0, boundary)), request);
}
