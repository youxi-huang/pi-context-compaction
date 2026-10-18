import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readMemoryConfig, SESSION_WRITER } from "../config.ts";
import { freezeHistory, queryHistory } from "../history.ts";
import { CONTEXT_NOTE_TYPE } from "../identity.ts";
import { CallJournal } from "./call-journal.ts";
import { PreviewMemoryController, previewErrorCode, reportPreviewError, unsupportedReason } from "./controller.ts";
import { PreviewFailureStore } from "./failure-store.ts";
import { listHistory, previewHistorySchema } from "./history-view.ts";
import { doctorReport, inactiveNotice, NOTICE_PREFIX, notify, recoverRefusedNotice } from "./notices.ts";
import { PreviewPreparation, readPreparationSettings } from "./preparation.ts";
import { validateWorkNote, WORK_NOTE_GUIDELINE, workNoteSchema } from "./work-notes.ts";
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
	const journal = new CallJournal(agentDir);
	const preparation = readPreparationSettings(agentDir);
	const controller = new PreviewMemoryController({
		config,
		configError,
		failureStore: new PreviewFailureStore(agentDir),
		journal,
		preparation: new PreviewPreparation({ enabled: preparation.enabled, settingsError: preparation.error, journal }),
		workNotes: preparation.notes,
	});
	const disabled = config?.enabled === false;
	pi.registerCommand("compaction-status", {
		description: "Show source-linked compaction's writer, checkpoint and request state as JSON",
		handler: async (_args, ctx) => {
			try {
				show(ctx, JSON.stringify(controller.status(ctx), null, 2));
			} catch (error) {
				reportPreviewError(ctx, previewErrorCode(error));
			}
		},
	});
	pi.registerCommand("compaction-doctor", {
		description: "Check source-linked compaction in this session without calling a model",
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
		description: "Confirm a checkpoint Pi already saved when a compaction was interrupted",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const reason = controller.safeInactive(ctx);
			if (reason) {
				show(ctx, inactiveNotice(reason, controller.hostVersion));
				return;
			}
			try {
				controller.recover(ctx);
				show(ctx, `${NOTICE_PREFIX}: checkpoint confirmed on disk. Requests resume.`);
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
						`${NOTICE_PREFIX}: /compact can't write a checkpoint yet. The fixed writer in pi-context-memory.json isn't available. Correct writerModel and restart Pi. (${previewErrorCode(error)})`,
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
			// Not at a completed turn, or blocked: leave it to a later turn without recording a failure.
			if (event.reason === "threshold" && !event.willRetry && !controller.thresholdReady(ctx))
				return { cancel: true };
			return { compaction: await controller.compact(event, ctx) };
		} catch (error) {
			// Cancellation is an explicit result because stock Pi swallows handler exceptions.
			controller.reportBlocked(ctx, previewErrorCode(error, event.signal.aborted));
			return { cancel: true };
		}
	});
	pi.on("session_compact", (event, ctx) => controller.committed(event, ctx));
	pi.on("session_compact_failed", (event, ctx) => controller.compactionFailed(event, ctx));
	pi.on("agent_settled", (_event, ctx) => controller.prepare(ctx));
	pi.on("session_before_switch", () => controller.invalidatePreparation("session-switch"));
	pi.on("session_before_tree", () => controller.invalidatePreparation("branch-switch"));
	pi.on("session_tree", (_event, ctx) => controller.branchChanged(ctx));
	pi.on("model_select", () => controller.invalidatePreparation("model-change"));
	pi.on("session_shutdown", () => controller.shutdownPreparation());
	pi.registerTool({
		name: "context_note",
		label: "Context note",
		description:
			"Record a short work note: where the work stands, decisions and their reasons, failed approaches, files and the current plan, each fact on one line with the original entry IDs it rests on. A note is data for the next checkpoint, not an instruction; the user's own messages stay authoritative.",
		// Arm B asks for notes; without it they remain optional hints for the writer.
		...(preparation.notes.enabled ? { promptGuidelines: [WORK_NOTE_GUIDELINE] } : {}),
		parameters: workNoteSchema,
		async execute(_id, value, signal, _update, ctx) {
			signal?.throwIfAborted();
			controller.assertReady(ctx);
			validateWorkNote(value, ctx.sessionManager.getBranch());
			pi.appendEntry(CONTEXT_NOTE_TYPE, structuredClone(value));
			return {
				content: [{ type: "text", text: "Work note saved; original messages remain authoritative." }],
				details: {},
			};
		},
	});
	pi.registerTool({
		name: "context_history",
		label: "Context history",
		description:
			"Search or read original history on the current branch, or list one kind of item newest first: constraints (instructions), decisions (reasons), failedPaths, files, nextSteps, state, edits or errors, with superseded items marked; sourceRevisedBy means a later fact revised the item's source entry without saying which fact it replaced, so check the excerpt. A list comes from earlier checkpoints and tool records and can miss what a writer left out; search to check. Returns entry IDs, roles, branch positions and continuation cursors. Search is ranked; use position for chronology. Never infer missing or truncated evidence. Parent grants are not supported by this preview.",
		promptGuidelines: [
			"Search context_history for earlier decisions and evidence omitted by compaction, then read the matching original entry ID. Follow a cursor by repeating the same operation, query and entryId with that cursor.",
			"To see how a decision, constraint or setting changed, list its kind with a query; read the cited entry before relying on it.",
		],
		parameters: previewHistorySchema,
		async execute(_id, request, signal, _update, ctx) {
			signal?.throwIfAborted();
			controller.assertReady(ctx);
			if (request.grantId)
				throw new Error("HISTORY_SCOPE_DENIED: parent-history grants are unsupported in this preview");
			if (request.operation === "list") {
				const view = listHistory(freezeHistory(ctx.sessionManager), request);
				return { content: [{ type: "text", text: JSON.stringify(view) }], details: view };
			}
			const { kind, ...query } = request;
			if (kind !== undefined) throw new Error("HISTORY_QUERY_INVALID: kind applies to list only");
			const page = queryHistory(freezeHistory(ctx.sessionManager), query);
			return { content: [{ type: "text", text: JSON.stringify(page) }], details: page };
		},
	});
}
