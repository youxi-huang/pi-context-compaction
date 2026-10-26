import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { canonicalize } from "../../compaction-core/src/canonical.ts";
import type { HistorySnapshot } from "../../compaction-core/src/history.ts";
import { hashEntries } from "../../compaction-core/src/notes.ts";
import type { RecordContentBlock, SessionRecord } from "../../compaction-core/src/records.ts";

/** Append-log order, never surface order or a numeric shadowedRange expansion. */
export function dshHistorySnapshot(sessionId: string, events: readonly SessionEvent[]): HistorySnapshot {
	const entries: SessionRecord[] = [];
	for (const [index, input] of events.entries()) {
		if (input.seq !== index) throw new Error("HISTORY_SOURCE_INVALID: expected the complete contiguous DSH log");
		// Stable key order also makes the core's existing cursor hash deterministic.
		const event = JSON.parse(canonicalize(input)) as SessionEvent;
		const base = {
			id: String(event.seq),
			parentId: entries.at(-1)?.id ?? null,
			timestamp: new Date(event.time).toISOString(),
		};
		const message =
			event.type === "user/message"
				? event.data
				: event.type === "assistant/message" || event.type === "tool/result"
					? event.data.message
					: undefined;
		if (!message) {
			entries.push({ ...base, type: "custom", customType: `dsh:${event.type}`, data: event });
			continue;
		}
		// Injected user-role context and native summaries are not original human instructions.
		const role =
			message.role === "tool"
				? "toolResult"
				: message.role === "user" && message.source.kind !== "user"
					? "context"
					: message.role;
		const content: RecordContentBlock[] = message.content.flatMap((block) =>
			block.type === "text" ? [{ type: "text", text: block.text }] : [],
		);
		// The native envelope enters both hashes, including source attribution and replacement metadata.
		// Keep it on a content block: JCS deliberately excludes host-only top-level fields.
		if (!content.length) {
			entries.push({ ...base, type: "custom", customType: `dsh:${event.type}`, data: event });
			continue;
		}
		content[0].nativeEvent = event;
		entries.push({
			...base,
			type: "message",
			message: {
				role,
				content,
				...(message.role === "tool" ? { toolCallId: message.toolCallId, isError: message.isError ?? false } : {}),
			},
		});
	}
	return { sessionId, leafId: entries.at(-1)?.id ?? null, scopeHash: hashEntries(entries), entries };
}
