import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readMemoryConfig, SESSION_WRITER } from "../config.ts";
import { freezeHistory, historyQuerySchema, queryHistory } from "../history.ts";
import { CONTEXT_NOTE_TYPE } from "../identity.ts";
import { noteSchema, validateNote } from "../notes.ts";
import { PreviewMemoryController, previewErrorCode, reportPreviewError, unsupportedReason } from "./controller.ts";
import { PreviewFailureStore } from "./failure-store.ts";
import { doctorReport, inactiveNotice, notify, recoverRefusedNotice } from "./notices.ts";
import { resolveWriterModel } from "./writer.ts";

/** Output of a command the user asked for: the UI, or stdout without one. */
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
	const disabled = config?.enabled === false;
	pi.registerCommand("compaction-status", {
		description: "Show the context-memory preview's writer, checkpoint, protection and request state as JSON",
		handler: async (_args, ctx) => {
			try {
				show(ctx, JSON.stringify(controller.status(ctx), null, 2));
			} catch (error) {
				reportPreviewError(ctx, previewErrorCode(error));
			}
		},
	});
	pi.registerCommand("compaction-doctor", {
		description: "Check whether the context-memory preview is loaded and usable here, without calling a model",
		handler: async (_args, ctx) => {
			try {
				show(
					ctx,
					doctorReport(controller.diagnose(ctx), { disabled, configError, writerModel: config?.writerModel }),
				);
			} catch (error) {
				reportPreviewError(ctx, previewErrorCode(error));
			}
		},
	});
	// Explicitly disabling this package ends its protection. Invalid config never takes this path.
	if (disabled) return;

	pi.registerCommand("compaction-recover", {
		description: "Confirm an already saved, staged checkpoint after an interrupted commit observation",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const reason = controller.safeInactive(ctx);
			if (reason) {
				show(ctx, inactiveNotice(reason, controller.hostVersion));
				return;
			}
			try {
				controller.recover(ctx);
				show(ctx, "context-memory preview: the staged checkpoint and its original sources were confirmed on disk.");
			} catch (error) {
				const code = previewErrorCode(error);
				show(
					ctx,
					recoverRefusedNotice(
						code,
						unsupportedReason(ctx.sessionManager, controller.hostVersion),
						controller.hostVersion,
					),
					"warning",
				);
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
	// Each submitted input starts a new notice episode, so a blocked input is reported once.
	pi.on("input", () => {
		controller.notices.nextEpisode();
	});
	// Stock cache warming uses a separate registry stream and bypasses request guards.
	// Stop it wherever this preview guards requests; throwing here would restore the stock decision.
	pi.on("cache_warming_decision", (_event, ctx) =>
		controller.safeInactive(ctx) ? undefined : { action: "stop" as const },
	);
	pi.on("session_start", (_event, ctx) => {
		controller.sessionStart(ctx);
		if (config && config.writerModel !== SESSION_WRITER && !controller.safeInactive(ctx)) {
			try {
				resolveWriterModel(config, ctx.modelRegistry, ctx.model);
			} catch (error) {
				if (controller.notices.once("writer"))
					notify(
						ctx,
						`context-memory preview: ${previewErrorCode(error)}. The fixed writer in pi-context-memory.json is not available; correct it and restart Pi before /compact.`,
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
			const reason = controller.safeInactive(ctx);
			if (reason) {
				// Not this package's session: leave manual and automatic compaction to Pi.
				controller.standAside(ctx, reason);
				return undefined;
			}
			if (event.reason === "manual") controller.notices.nextEpisode();
			return { compaction: await controller.compact(event, ctx) };
		} catch (error) {
			// Cancellation is an explicit result because stock Pi swallows handler exceptions.
			controller.reportBlocked(ctx, previewErrorCode(error, event.signal.aborted));
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
