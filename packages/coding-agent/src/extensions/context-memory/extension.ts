import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { MemoryController, MemoryHost } from "./controller.ts";
import { freezeHistory, grantedHistory, historyQuerySchema, queryHistory } from "./history.ts";
import { CONTEXT_NOTE_TYPE } from "./identity.ts";
import { noteSchema, validateNote } from "./notes.ts";

export function memoryExtension(host: MemoryHost, controller: MemoryController) {
	return (pi: ExtensionAPI): void => {
		pi.on("context", (event, ctx) => ({ messages: controller.context(event.messages, ctx) }));
		pi.on("before_provider_request", (event) => controller.beforeRequest(event.payload));
		pi.registerCommand("compaction-status", {
			description: "Show context-memory build, writer, checkpoint and request state",
			handler: async (_args, ctx) => {
				const text = JSON.stringify(controller.status(), null, 2);
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				else console.log(text);
			},
		});
		if (!host.config.enabled) return;

		pi.on("input", () => controller.acceptInput());
		pi.on("session_tree", () => controller.branchChanged());
		pi.on("session_start", (_event, ctx) => controller.refresh(ctx.model));
		pi.on("model_select", (event) => controller.refresh(event.model));
		pi.on("turn_end", (_event, ctx) => controller.refresh(ctx.model));
		pi.on("session_before_compact", async (event, ctx) => ({ compaction: await controller.compact(event, ctx) }));
		pi.on("session_compact", () => controller.committed());
		pi.on("session_compact_failed", (event) => controller.fail(event.errorMessage ?? "Compaction cancelled"));
		pi.registerTool({
			name: "context_note",
			label: "Context note",
			description:
				"Submit an optional, source-backed note candidate about current decisions, failed attempts or work state. It is reconciled at compaction; omitting this tool does not block work. Sources must be original entry IDs returned by context_history.",
			parameters: noteSchema,
			async execute(_id, value, _signal, _update, ctx) {
				controller.assertCanNote();
				const note = validateNote(value, ctx.sessionManager.getBranch(), 2000);
				pi.appendEntry(CONTEXT_NOTE_TYPE, note);
				return {
					content: [{ type: "text", text: "Note candidate saved; original messages remain authoritative." }],
					details: {},
				};
			},
		});
		pi.registerTool({
			name: "context_history",
			label: "Context history",
			description:
				"Search or read original history on the current branch. Returns entry IDs, roles, branch anchors and a continuation cursor. Use a host-issued grantId only for explicitly inherited parent evidence. Never infer a missing or truncated result.",
			promptGuidelines: [
				"For earlier decisions or tool evidence omitted by compaction, search context_history, then read the matching entry ID. Follow a returned cursor to read the remaining source.",
			],
			parameters: historyQuerySchema,
			async execute(_id, request, signal, _update, ctx) {
				signal?.throwIfAborted();
				const snapshot = request.grantId
					? grantedHistory(request.grantId, ctx.sessionManager.getSessionId())
					: freezeHistory(ctx.sessionManager);
				const page = queryHistory(snapshot, request);
				return { content: [{ type: "text", text: JSON.stringify(page) }], details: page };
			},
		});
	};
}
