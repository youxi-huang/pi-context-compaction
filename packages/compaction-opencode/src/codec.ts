import type { Message, Part } from "@opencode-ai/sdk";
import { canonicalize } from "../../compaction-core/src/canonical.ts";
import type { HistorySnapshot } from "../../compaction-core/src/history.ts";
import { hashEntries } from "../../compaction-core/src/notes.ts";
import type { SessionRecord } from "../../compaction-core/src/records.ts";

export interface OpenCodeMessage {
	info: Message;
	parts: Part[];
}

/** Native message envelopes and part IDs, with tool output attributed to the tool. */
export function openCodeHistorySnapshot(sessionId: string, messages: readonly OpenCodeMessage[]): HistorySnapshot {
	const entries: SessionRecord[] = [];
	const seen = new Set<string>();
	function base(id: string, created: number) {
		if (!id || id.length > 64 || seen.has(id))
			throw new Error("HISTORY_SOURCE_INVALID: invalid or duplicate native ID");
		seen.add(id);
		return { id, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(created).toISOString() };
	}
	for (const input of messages) {
		const { info, parts } = JSON.parse(canonicalize(input)) as OpenCodeMessage;
		if (info.sessionID !== sessionId) throw new Error("HISTORY_SCOPE_DENIED: message belongs to another session");
		entries.push({ ...base(info.id, info.time.created), type: "custom", customType: "opencode:message", data: info });
		for (const part of parts) {
			if (part.sessionID !== sessionId || part.messageID !== info.id)
				throw new Error("HISTORY_SCOPE_DENIED: part belongs to another message or session");
			const identity = base(part.id, info.time.created);
			if (part.type === "text" && !part.ignored) {
				const role = part.synthetic || (info.role === "assistant" && info.summary) ? "context" : info.role;
				entries.push({
					...identity,
					type: "message",
					message: { role, content: [{ type: "text", text: part.text, nativePart: part }] },
				});
			} else if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
				entries.push({
					...identity,
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: part.callID,
						toolName: part.tool,
						isError: part.state.status === "error",
						content: [
							{
								type: "text",
								text: part.state.status === "completed" ? part.state.output : part.state.error,
								nativePart: part,
							},
						],
					},
				});
			} else {
				entries.push({ ...identity, type: "custom", customType: `opencode:${part.type}`, data: part });
			}
		}
	}
	return { sessionId, leafId: entries.at(-1)?.id ?? null, scopeHash: hashEntries(entries), entries };
}
