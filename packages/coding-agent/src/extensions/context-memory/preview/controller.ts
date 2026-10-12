import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getInitialSystemMessage, type Tool } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	convertToLlm,
	type ExtensionContext,
	estimateTokens,
	type SessionBeforeCompactEvent,
	type SessionCompactEvent,
	type SessionCompactFailedEvent,
	type SessionEntry,
	type SessionProjection,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { type MemoryConfig, memoryBudget, SESSION_WRITER, selectNoteBudget, textTokens } from "../config.ts";
import { PROJECT_CODES } from "../events.ts";
import { CONTEXT_KEEP_NONE, CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION, isRecord } from "../identity.ts";
import {
	checkpointLineage,
	compactedSourceTokens,
	hashEntries,
	latestMemory,
	type MemoryNote,
	noteBytes,
	noteIncrements,
	renderNote,
	shrinkLineage,
} from "../notes.ts";
import { PREVIEW_BUILD_ID } from "./build.ts";
import type { PreviewCompaction, PreviewFailureStoreContract, PreviewSession } from "./contracts.ts";
import { modelName, resolveWriterModel, type WriterProgress, writeMemory } from "./writer.ts";

const PREVIEW_CODES = new Set([
	"CONTEXT_PREVIEW_UNSUPPORTED",
	"CONTEXT_COMPACTION_CANCELLED",
	"CONTEXT_PREVIEW_PENDING",
	"CONTEXT_PREVIEW_MARKER_INVALID",
	"CONTEXT_PREVIEW_MARKER_IO",
	"CONTEXT_PREVIEW_SESSION_INVALID",
	"CONTEXT_PREVIEW_SESSION_IO",
	"CONTEXT_PREVIEW_COMMIT_UNCONFIRMED",
]);

/** Neither provider error text nor model output enters the failure marker or UI. */
export function previewErrorCode(error: unknown, aborted = false): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	const matched = message.slice(0, 256).match(/^(?:CONTEXT|HISTORY)_[A-Z_]{1,40}\b/)?.[0];
	if (matched && (PROJECT_CODES.has(matched) || PREVIEW_CODES.has(matched))) return matched;
	return aborted ? "CONTEXT_COMPACTION_CANCELLED" : "CONTEXT_WRITER_FAILED";
}

export function reportPreviewError(ctx: ExtensionContext, code: string): void {
	const text = `context-memory preview: ${code}. Requests are blocked; use an explicit /compact retry after correcting the cause. New input and /reload do not clear this state.`;
	// Notification failures must never turn a cancelled compaction into stock fallback.
	try {
		if (ctx.hasUI) ctx.ui.notify(text, "error");
		else console.warn(text);
	} catch {
		// The persistent marker and request abort remain authoritative.
	}
}

export function assertToolPairs(messages: readonly AgentMessage[]): void {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			if (pending.size) throw new Error("CONTEXT_TOOL_BOUNDARY: missing tool results before an assistant turn");
			for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
		} else if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) throw new Error("CONTEXT_TOOL_BOUNDARY: an unmatched tool result");
		} else if (message.role === "user" && pending.size) {
			throw new Error("CONTEXT_TOOL_BOUNDARY: user input interrupts an unfinished tool batch");
		}
	}
	if (pending.size) throw new Error("CONTEXT_TOOL_BOUNDARY: wait for the tool batch to finish");
}

/** Keep complete recent turns; a zero budget uses stock Pi's no-matching-kept-entry convention. */
export function chooseCut(
	branch: readonly SessionEntry[],
	keepRecentTokens: number,
	projection: SessionProjection = buildSessionProjection([...branch]),
): number {
	if (keepRecentTokens <= 0) return branch.length;
	const projected = new Map(projection.entries.map((entry) => [entry.sourceEntry.id, entry.messages]));
	const starts = branch.flatMap((entry, index) =>
		entry.type === "message" && entry.message.role === "user" && projected.get(entry.id)?.length ? [index] : [],
	);
	if (!starts.length) throw new Error("CONTEXT_NO_CUT: no source turn is available");
	let accumulated = 0;
	for (let index = branch.length - 1; index >= 0; index--) {
		if (branch[index].type === "compaction") continue;
		accumulated += (projected.get(branch[index].id) ?? []).reduce((sum, message) => sum + estimateTokens(message), 0);
		if (accumulated >= keepRecentTokens) return starts.find((start) => start >= index) ?? starts[starts.length - 1];
	}
	return starts[starts.length - 1];
}

/** Pi retries omit the latest failed response without changing raw evidence or a prior checkpoint. */
function assertRecoveryEdits(branch: readonly SessionEntry[]): void {
	let lastMessage: SessionEntry | undefined;
	for (const entry of branch) {
		if (entry.type === "context_edit") {
			if (
				entry.replacement !== null ||
				!lastMessage ||
				lastMessage?.id !== entry.targetId ||
				lastMessage.type !== "message" ||
				lastMessage.message.role !== "assistant" ||
				lastMessage.message.stopReason !== "error" ||
				lastMessage.message.content.some((part) => part.type === "toolCall")
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

/** Abort guards can leave new user input on disk; recovery must keep that whole unfinished turn. */
function interruptedTurnStart(branch: readonly SessionEntry[]): number | undefined {
	let completed = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			(entry.message.stopReason === "stop" || entry.message.stopReason === "length")
		) {
			completed = index;
			break;
		}
	}
	if (completed < 0) throw new Error("CONTEXT_TOOL_BOUNDARY: no completed source turn precedes recovery");
	for (let index = completed + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user") return index;
	}
	return undefined;
}

function withPendingNotes(
	messages: readonly AgentMessage[],
	increments: readonly MemoryNote[],
	noteTokens: number,
): AgentMessage[] {
	const result = messages.filter(
		(message) => !(message.role === "custom" && message.customType === "context-memory-pending"),
	);
	if (increments.length) {
		const content = `Unverified note candidates. Original evidence and current user instructions take precedence.\n${increments.map((note) => renderNote(note)).join("\n\n")}`;
		if (textTokens(content) <= noteTokens) {
			const candidate: AgentMessage = {
				role: "custom",
				customType: "context-memory-pending",
				content,
				display: false,
				timestamp: 0,
			};
			// Preserve a projected leading system message so Pi continues to own prompt/tool state.
			result.splice(result[0]?.role === "system" ? 1 : 0, 0, candidate);
		}
	}
	return result;
}

/** The preview neither migrates existing checkpoints nor accepts a second compactor's summary. */
export function assertPreviewSession(session: PreviewSession): void {
	if (VERSION !== "1.1.0") {
		throw new Error("CONTEXT_PREVIEW_UNSUPPORTED: this preview is validated only on official Pi 1.1.0");
	}
	if (!session.getSessionFile()) throw new Error("CONTEXT_PREVIEW_UNSUPPORTED: a persistent session is required");
	const branch = session.getBranch();
	assertRecoveryEdits(branch);
	for (const entry of branch) {
		if (entry.type !== "compaction") continue;
		if (
			!isRecord(entry.details) ||
			entry.details.kind !== CONTEXT_MEMORY_KIND ||
			typeof entry.details.build !== "string" ||
			!entry.details.build.startsWith("stock-preview")
		) {
			throw new Error(
				"CONTEXT_MIGRATION_REQUIRED: start a new preview session; existing checkpoints are not migrated",
			);
		}
		// Validate each stored source prefix, schema, budget and quotation, including older checkpoints.
		latestMemory(branch.slice(0, branch.indexOf(entry) + 1));
	}
	for (const entry of branch) {
		if (entry.type === "message" && "content" in entry.message && Array.isArray(entry.message.content)) {
			if (entry.message.content.some((part) => part.type === "image")) {
				throw new Error("CONTEXT_PREVIEW_UNSUPPORTED: image-bearing sessions are not supported by this preview");
			}
		}
		if (entry.type === "custom_message" && Array.isArray(entry.content)) {
			if (entry.content.some((part) => part.type !== "text")) {
				throw new Error("CONTEXT_PREVIEW_UNSUPPORTED: non-text custom messages are not supported");
			}
		}
	}
}

export interface PreviewControllerOptions {
	config?: Readonly<MemoryConfig>;
	failureStore: PreviewFailureStoreContract;
	/** Config parse errors still install cancellation and request guards. */
	configError?: string;
}

/** All host effects pass through public extension contexts and the independent failure marker. */
export class PreviewMemoryController {
	private readonly config?: Readonly<MemoryConfig>;
	private readonly store: PreviewFailureStoreContract;
	private readonly configError?: string;
	private readonly stickyFailures = new Map<string, string>();
	private readonly observedFailures = new Map<string, string>();
	private readonly activeCompactions = new Set<string>();
	private readonly stagedCompactions = new Set<string>();
	private activeTools: () => Tool[] = () => [];
	private lastProgress?: WriterProgress;

	constructor(options: PreviewControllerOptions) {
		this.config = options.config;
		this.store = options.failureStore;
		this.configError = options.configError;
	}

	bindTools(tools: () => Tool[]): void {
		this.activeTools = tools;
	}

	status(ctx: ExtensionContext) {
		const state = this.store.status(ctx.sessionManager);
		let checkpointId: string | undefined;
		let code = this.configError ?? this.stickyFailures.get(ctx.sessionManager.getSessionId()) ?? state.code;
		try {
			assertPreviewSession(ctx.sessionManager);
			checkpointId = latestMemory(ctx.sessionManager.getBranch())?.entry.id;
		} catch (error) {
			code = previewErrorCode(error);
		}
		let writer: string | undefined;
		let writerError: string | undefined;
		if (this.config) {
			try {
				writer = modelName(resolveWriterModel(this.config, ctx.modelRegistry, ctx.model));
			} catch (error) {
				writerError = previewErrorCode(error);
			}
		}
		return {
			build: PREVIEW_BUILD_ID,
			enabled: this.config?.enabled ?? true,
			state: code ? "blocked" : state.state,
			...(code ? { code } : {}),
			writerModel: this.config?.writerModel,
			writer,
			writerError,
			checkpointId,
			noteBudgetMode: this.config?.noteTokens === undefined ? "tiered" : "fixed",
			noteRepair: this.config?.noteRepair,
			manualOnly: true,
			lastWriter: this.lastProgress,
		};
	}

	assertReady(ctx: ExtensionContext): void {
		if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
		assertPreviewSession(ctx.sessionManager);
		const sticky = this.stickyFailures.get(ctx.sessionManager.getSessionId());
		if (sticky) throw new Error(sticky);
		this.store.assertReady(ctx.sessionManager);
	}

	/** In-process stickiness covers a marker write that failed before it could reach disk. */
	fail(ctx: ExtensionContext, code: string): void {
		const sessionId = ctx.sessionManager.getSessionId();
		this.observedFailures.set(sessionId, code);
		this.stickyFailures.set(sessionId, code);
		try {
			this.store.fail(ctx.sessionManager, code);
		} catch (error) {
			this.stickyFailures.set(sessionId, previewErrorCode(error));
		}
	}

	/** Stock Pi catches extension exceptions: abort is necessary before reporting any guard failure. */
	guard(ctx: ExtensionContext, operation: () => void): boolean {
		try {
			operation();
			return true;
		} catch (error) {
			const code = previewErrorCode(error);
			this.fail(ctx, code);
			ctx.abort();
			reportPreviewError(ctx, code);
			return false;
		}
	}

	context(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] {
		let result = messages;
		this.guard(ctx, () => {
			this.assertReady(ctx);
			if (!ctx.model || !this.config) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
			const branch = ctx.sessionManager.getBranch();
			const checkpoint = latestMemory(branch);
			if (checkpoint) {
				const restored = messages.filter((message) => message.role === "compactionSummary");
				if (restored.length !== 1 || restored[0].summary !== checkpoint.entry.summary) {
					throw new Error("CONTEXT_RECOVERY_MISSING: the validated checkpoint is missing from model context");
				}
			}
			const budget = memoryBudget(ctx.model, this.config);
			result = withPendingNotes(messages, noteIncrements(branch, checkpoint?.entry.id), budget.noteTokens);
			assertToolPairs(result);
			const estimate =
				result.reduce((sum, message) => sum + estimateTokens(message), 0) +
				(getInitialSystemMessage(result) ? 0 : textTokens(ctx.getSystemPrompt()));
			if (estimate > budget.inputLimit) throw new Error("CONTEXT_INPUT_TOO_LARGE");
		});
		return result;
	}

	beforeRequest(payload: unknown, ctx: ExtensionContext): void {
		this.guard(ctx, () => {
			this.assertReady(ctx);
			if (!ctx.model || !this.config) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
			const serialized = JSON.stringify(payload);
			const checkpoint = latestMemory(ctx.sessionManager.getBranch());
			if (checkpoint && !serialized?.includes(JSON.stringify(checkpoint.entry.summary).slice(1, -1))) {
				throw new Error("CONTEXT_RECOVERY_MISSING: the provider payload lost the validated checkpoint");
			}
			if (textTokens(serialized ?? "") > memoryBudget(ctx.model, this.config).inputLimit) {
				throw new Error("CONTEXT_PAYLOAD_TOO_LARGE");
			}
		});
	}

	async compact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<PreviewCompaction> {
		this.activeCompactions.add(ctx.sessionManager.getSessionId());
		this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
		try {
			if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
			assertPreviewSession(ctx.sessionManager);
			if (event.reason !== "manual" || event.willRetry) {
				throw new Error("CONTEXT_PREVIEW_UNSUPPORTED: use manual compaction at a completed turn");
			}
			event.signal.throwIfAborted();
			const branch = structuredClone(ctx.sessionManager.getBranch());
			const projection = ctx.sessionManager.buildSessionProjection();
			assertToolPairs(projection.messages);
			const last = [...projection.messages].reverse().find((message) => message.role !== "system");
			const completed = last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
			const recovering =
				this.stickyFailures.has(ctx.sessionManager.getSessionId()) ||
				this.store.status(ctx.sessionManager).state !== "ready";
			const terminated =
				last?.role === "user" ||
				(last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted"));
			if (!last || !(completed || (recovering && terminated)) || ctx.hasPendingMessages()) {
				throw new Error("CONTEXT_TOOL_BOUNDARY: manual compaction requires a completed turn with no queued input");
			}
			if (!ctx.model || !ctx.sessionManager.getLeafId()) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
			// An explicit manual retry replaces blocked/pending with a new durable pending attempt.
			const attempt = this.store.begin(ctx.sessionManager, true);
			this.observedFailures.delete(attempt.sessionId);
			const snapshot = {
				sessionId: attempt.sessionId,
				leafId: attempt.leafId,
				lastCheckpointId: attempt.lastCheckpointId,
			};
			if (hashEntries(branch) !== attempt.sourceHash) throw new Error("CONTEXT_SOURCE_CHANGED");
			const budget = memoryBudget(ctx.model, this.config);
			const interrupted = !completed ? interruptedTurnStart(branch) : undefined;
			const cut = Math.min(chooseCut(branch, budget.recentTokens, projection), interrupted ?? branch.length);
			if (cut < 1) throw new Error("CONTEXT_NO_CUT");
			const keptIds = new Set(branch.slice(cut).map((entry) => entry.id));
			const kept = projection.entries
				.filter((entry) => entry.sourceEntry.type !== "compaction" && keptIds.has(entry.sourceEntry.id))
				.flatMap((entry) => entry.messages);
			assertToolPairs(kept);
			const firstKeptEntryId = cut < branch.length ? branch[cut].id : CONTEXT_KEEP_NONE;
			const previous = latestMemory(branch);
			const after = previous ? branch.findIndex((entry) => entry.id === previous.memory.coveredThrough) : -1;
			const increments = noteIncrements(branch, previous?.entry.id);
			const activeIds = new Set(
				projection.entries.filter((entry) => entry.messages.length > 0).map((entry) => entry.sourceEntry.id),
			);
			const released = branch.slice(0, cut).filter((entry) => activeIds.has(entry.id));
			const policy = selectNoteBudget(
				this.config,
				budget.threshold,
				compactedSourceTokens(released),
				previous ? Math.ceil(noteBytes(previous.memory.note) / 3) : 0,
			);
			const projectedMessages = [...projection.messages];
			while (projectedMessages.length) {
				const tail = projectedMessages[projectedMessages.length - 1];
				if (tail.role === "assistant" && (tail.stopReason === "error" || tail.stopReason === "aborted")) {
					projectedMessages.pop();
				} else break;
			}
			const prefixMessages = convertToLlm(withPendingNotes(projectedMessages, increments, budget.noteTokens));
			assertToolPairs(prefixMessages);
			const sessionWriter = this.config.writerModel === SESSION_WRITER;
			const prefix = getInitialSystemMessage(prefixMessages)
				? { messages: prefixMessages }
				: { systemPrompt: ctx.getSystemPrompt(), messages: prefixMessages, tools: this.activeTools() };
			this.lastProgress = undefined;
			const written = await writeMemory({
				config: this.config,
				registry: ctx.modelRegistry,
				sessionModel: ctx.model,
				prefix: sessionWriter ? prefix : undefined,
				sessionThinkingLevel: sessionWriter ? ctx.thinkingLevel : undefined,
				previous: previous?.memory.note,
				increments,
				uncovered: branch.slice(after + 1),
				branch,
				noteTokens: policy.hardTokens,
				baseNoteTokens: policy.baseTokens,
				signal: event.signal,
				customInstructions: event.customInstructions,
				onProgress: (progress) => {
					this.lastProgress = progress;
				},
			});
			event.signal.throwIfAborted();
			if (
				snapshot.sessionId !== ctx.sessionManager.getSessionId() ||
				snapshot.leafId !== ctx.sessionManager.getLeafId() ||
				hashEntries(branch) !== hashEntries(ctx.sessionManager.getBranch())
			) {
				throw new Error("CONTEXT_SOURCE_CHANGED: discard the generated candidate");
			}
			const fixedAfter =
				textTokens(ctx.getSystemPrompt()) + kept.reduce((sum, message) => sum + estimateTokens(message), 0);
			let lineage = checkpointLineage(branch);
			let summary = renderNote(written.note, lineage);
			while (lineage.length && textTokens(summary) + fixedAfter > budget.threshold) {
				lineage = shrinkLineage(lineage);
				summary = renderNote(written.note, lineage);
			}
			if (textTokens(summary) + fixedAfter > budget.threshold) throw new Error("CONTEXT_RECOVERY_TOO_LARGE");
			const candidate: PreviewCompaction = {
				summary,
				firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				usage: written.usage,
				details: {
					kind: CONTEXT_MEMORY_KIND,
					version: CONTEXT_MEMORY_VERSION,
					note: written.note,
					coveredThrough: attempt.leafId,
					sourceHash: attempt.sourceHash,
					snapshot,
					writerModel: written.writerModel,
					chunkCount: written.chunkCount,
					build: PREVIEW_BUILD_ID,
					noteBudget: policy,
				},
			};
			this.store.stage(ctx.sessionManager, attempt, candidate);
			this.stagedCompactions.add(attempt.sessionId);
			return candidate;
		} catch (error) {
			const code = previewErrorCode(error, event.signal.aborted);
			this.fail(ctx, code);
			throw new Error(code);
		}
	}

	committed(event: SessionCompactEvent, ctx: ExtensionContext): void {
		this.activeCompactions.delete(ctx.sessionManager.getSessionId());
		this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
		try {
			assertPreviewSession(ctx.sessionManager);
			const memory = latestMemory(ctx.sessionManager.getBranch());
			if (!event.fromExtension || memory?.entry.id !== event.compactionEntry.id) {
				throw new Error("CONTEXT_PREVIEW_COMMIT_UNCONFIRMED");
			}
			// The marker owner reads the exact checkpoint and sources back from persistent JSONL.
			this.store.commit(ctx.sessionManager, event.compactionEntry);
			this.stickyFailures.delete(ctx.sessionManager.getSessionId());
			this.observedFailures.delete(ctx.sessionManager.getSessionId());
		} catch (error) {
			const code = previewErrorCode(error);
			this.fail(ctx, code);
			ctx.abort();
			reportPreviewError(ctx, code);
		}
	}

	/** Reconcile a staged checkpoint that Pi saved but whose commit observation was interrupted. */
	recover(ctx: ExtensionContext): void {
		try {
			if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
			assertPreviewSession(ctx.sessionManager);
			const leaf = ctx.sessionManager.getLeafEntry();
			const memory = latestMemory(ctx.sessionManager.getBranch());
			if (leaf?.type !== "compaction" || memory?.entry.id !== leaf.id) {
				throw new Error("CONTEXT_PREVIEW_COMMIT_UNCONFIRMED");
			}
			this.store.recover(ctx.sessionManager, leaf);
			this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
			this.stickyFailures.delete(ctx.sessionManager.getSessionId());
			this.observedFailures.delete(ctx.sessionManager.getSessionId());
		} catch (error) {
			const code = previewErrorCode(error);
			this.fail(ctx, code);
			throw new Error(code);
		}
	}

	compactionFailed(event: SessionCompactFailedEvent, ctx: ExtensionContext): void {
		// Preparation can reject "nothing to compact" before this extension's hook runs.
		// No writer or staged candidate existed in that case, so retain the existing state.
		if (!this.activeCompactions.delete(ctx.sessionManager.getSessionId())) return;
		const specific = this.observedFailures.get(ctx.sessionManager.getSessionId());
		const staged = this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
		const code =
			specific ??
			(event.aborted
				? "CONTEXT_COMPACTION_CANCELLED"
				: staged
					? "CONTEXT_PREVIEW_COMMIT_UNCONFIRMED"
					: previewErrorCode(event.errorMessage));
		this.fail(ctx, code);
		reportPreviewError(ctx, code);
	}
}
