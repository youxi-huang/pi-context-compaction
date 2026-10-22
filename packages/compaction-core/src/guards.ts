// Lifted from the preview controller into the host-neutral core (v0.7.0 WP2 step 4): the pure
// guards of the specification's tool-pairing and request-limit rules — `assertToolPairs`,
// `requestLimit` — and the recovery-edit guard `assertRecoveryEdits`. `assertToolPairs` operates on
// the projected-message shape (reduction.ts `ReducibleMessage`, that shape's home); the host's
// `SessionEntry` type import became the structural record shapes in records.ts, and the host's
// output reserve is the caller's to supply: the Pi adapter binds
// `DEFAULT_COMPACTION_SETTINGS.reserveTokens`. Logic, bounds and thrown messages are unchanged
// (rule K2).
import { isRecord } from "./identity.ts";
import type { SessionRecord } from "./records.ts";
import type { ReducibleMessage } from "./reduction.ts";

export function assertToolPairs(messages: readonly ReducibleMessage[]): void {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			if (pending.size) throw new Error("CONTEXT_TOOL_BOUNDARY: missing tool results before an assistant turn");
			if (Array.isArray(message.content))
				for (const part of message.content)
					if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string") pending.add(part.id);
		} else if (message.role === "toolResult") {
			if (typeof message.toolCallId !== "string" || !pending.delete(message.toolCallId))
				throw new Error("CONTEXT_TOOL_BOUNDARY: an unmatched tool result");
		} else if (message.role === "user" && pending.size) {
			throw new Error("CONTEXT_TOOL_BOUNDARY: user input interrupts an unfinished tool batch");
		}
	}
	if (pending.size) throw new Error("CONTEXT_TOOL_BOUNDARY: wait for the tool batch to finish");
}

/**
 * The request guard's limit: the host's threshold, window minus the host's output reserve. The host
 * compacts above it after a turn or before a prompt, so a request below it is never stopped. The
 * model's output maximum does not lower it.
 */
export function requestLimit(model: { contextWindow: number }, reserveTokens: number): number {
	const limit = model.contextWindow - reserveTokens;
	if (!Number.isFinite(limit) || limit < 2048)
		throw new Error("CONTEXT_CAPACITY: model window is too small or unknown");
	return limit;
}

/** Host retries omit the latest failed response without changing raw evidence or a prior checkpoint. */
export function assertRecoveryEdits(branch: readonly SessionRecord[]): void {
	let lastMessage: SessionRecord | undefined;
	for (const entry of branch) {
		if (entry.type === "context_edit") {
			if (
				entry.replacement !== null ||
				!lastMessage ||
				lastMessage?.id !== entry.targetId ||
				lastMessage.type !== "message" ||
				lastMessage.message.role !== "assistant" ||
				lastMessage.message.stopReason !== "error" ||
				(Array.isArray(lastMessage.message.content) &&
					lastMessage.message.content.some((part) => part.type === "toolCall"))
			) {
				throw new Error("CONTEXT_PREVIEW_UNSUPPORTED: only failed-response recovery omissions are supported");
			}
		} else if (entry.type === "message") {
			lastMessage = entry;
		} else if (entry.type === "compaction") {
			// Judge an edit against checkpoints preceding it, including after later compactions are appended.
			lastMessage = undefined;
		}
	}
}
