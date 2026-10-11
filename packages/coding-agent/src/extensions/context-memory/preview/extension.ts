import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readMemoryConfig, SESSION_WRITER } from "../config.ts";
import { freezeHistory, historyQuerySchema, queryHistory } from "../history.ts";
import { CONTEXT_NOTE_TYPE } from "../identity.ts";
import { noteSchema, validateNote } from "../notes.ts";
import { PreviewMemoryController, previewErrorCode, reportPreviewError } from "./controller.ts";
import { PreviewFailureStore } from "./failure-store.ts";
import { resolveWriterModel } from "./writer.ts";

function show(ctx: ExtensionContext, text: string, kind: "info" | "warning" = "info"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(text, kind);
		else console.log(text);
	} catch {
		// Status display is not a compaction or recovery operation.
	}
}

/** Ordinary Pi package entry. It installs no resident loader, host patches or global settings. */
export default function contextMemoryPreview(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	let config: ReturnType<typeof readMemoryConfig> | undefined;
	let configError: string | undefined;
	try {
		config = readMemoryConfig(agentDir);
	} catch {
		// A factory error would make stock Pi drop the extension and permit native compaction.
		configError = "CONTEXT_CONFIG";
	}
	const controller = new PreviewMemoryController({
		config,
		configError,
		failureStore: new PreviewFailureStore(agentDir),
	});
	pi.registerCommand("compaction-status", {
		description: "Show the independent context-memory preview writer, checkpoint and persistent request state",
		handler: async (_args, ctx) => {
			try {
				show(ctx, JSON.stringify(controller.status(ctx), null, 2));
			} catch (error) {
				reportPreviewError(ctx, previewErrorCode(error));
			}
		},
	});
	// Explicitly disabling this package ends its protection. Invalid config never takes this path.
	if (config?.enabled === false) return;

	pi.registerCommand("compaction-recover", {
		description: "Confirm an already saved, staged checkpoint after an interrupted commit observation",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				controller.recover(ctx);
				show(ctx, "context-memory preview: the staged checkpoint and its original sources were confirmed on disk.");
			} catch (error) {
				reportPreviewError(ctx, previewErrorCode(error));
			}
		},
	});

	controller.bindTools(() => {
		const active = new Set(pi.getActiveTools());
		return pi
			.getAllTools()
			.filter((tool) => active.has(tool.name))
			.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
	});
	// Stock cache warming uses a separate registry stream and bypasses request guards.
	// Explicitly stop it for this preview; throwing here would restore the stock decision.
	pi.on("cache_warming_decision", () => ({ action: "stop" }));
	pi.on("session_start", (_event, ctx) => {
		controller.guard(ctx, () => controller.assertReady(ctx));
		if (config && config.writerModel !== SESSION_WRITER) {
			try {
				resolveWriterModel(config, ctx.modelRegistry, ctx.model);
			} catch (error) {
				show(
					ctx,
					`context-memory preview: ${previewErrorCode(error)}. Correct the fixed writer before /compact.`,
					"warning",
				);
			}
		}
	});
	pi.on("context", (event, ctx) => ({ messages: controller.context(event.messages, ctx) }));
	pi.on("context_with_system", (event, ctx) => ({ messages: controller.context(event.messages, ctx) }));
	pi.on("before_provider_request", (event, ctx) => controller.beforeRequest(event.payload, ctx));
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			return { compaction: await controller.compact(event, ctx) };
		} catch (error) {
			// Cancellation is an explicit result because stock Pi swallows handler exceptions.
			reportPreviewError(ctx, previewErrorCode(error, event.signal.aborted));
			return { cancel: true };
		}
	});
	pi.on("session_compact", (event, ctx) => controller.committed(event, ctx));
	pi.on("session_compact_failed", (event, ctx) => controller.compactionFailed(event, ctx));
	pi.registerTool({
		name: "context_note",
		label: "Context note",
		description:
			"Submit an optional source-backed note about decisions or work state. It is an unverified candidate until compaction reconciles it against original entries. Cite original entry IDs returned by context_history.",
		parameters: noteSchema,
		async execute(_id, value, signal, _update, ctx) {
			signal?.throwIfAborted();
			controller.assertReady(ctx);
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
			"Search or read original history on the current branch. Returns entry IDs, roles, branch positions and continuation cursors. Search is ranked; use position for chronology. Never infer missing or truncated evidence. Parent grants are not supported by this preview.",
		promptGuidelines: [
			"Search context_history for earlier decisions and evidence omitted by compaction, then read the matching original entry ID. Follow a cursor by repeating the same operation, query and entryId with that cursor.",
		],
		parameters: historyQuerySchema,
		async execute(_id, request, signal, _update, ctx) {
			signal?.throwIfAborted();
			controller.assertReady(ctx);
			if (request.grantId)
				throw new Error("HISTORY_SCOPE_DENIED: parent-history grants are unsupported in this preview");
			const page = queryHistory(freezeHistory(ctx.sessionManager), request);
			return { content: [{ type: "text", text: JSON.stringify(page) }], details: page };
		},
	});
}
