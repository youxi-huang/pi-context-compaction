import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getInitialSystemMessage, type Tool } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type CompactionEntry,
	convertToLlm,
	DEFAULT_COMPACTION_SETTINGS,
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
	noteBytes,
	noteIncrements,
	renderNote,
	shrinkLineage,
	validateMemoryCheckpoints,
	validateNote,
} from "../notes.ts";
import { PREVIEW_BUILD_ID } from "./build.ts";
import type {
	InactiveReason,
	PreviewCompaction,
	PreviewDiagnosis,
	PreviewFailureStoreContract,
	PreviewSession,
} from "./contracts.ts";
import { createPreviewBranchSnapshot } from "./failure-store.ts";
import { blockedNotice, inactiveNotice, NoticeGate, notify, readyNotice, SUPPORTED_PI } from "./notices.ts";
import { freezePreparationInput, type PreparationSubmission } from "./preparation-candidate.ts";
import type { PreviewPreparationCoordinator } from "./preparation-coordinator.ts";
import {
	modelName,
	resolveWriterModel,
	sumMemoryUsage,
	type WriteMemoryResult,
	type WriterProgress,
	writeMemory,
	writerContractHashes,
	writerReasoning,
} from "./writer.ts";

const PREVIEW_CODES = new Set([
	"CONTEXT_PREVIEW_UNSUPPORTED",
	"CONTEXT_COMPACTION_CANCELLED",
	"CONTEXT_PREVIEW_PENDING",
	"CONTEXT_PREVIEW_MARKER_INVALID",
	"CONTEXT_PREVIEW_MARKER_IO",
	"CONTEXT_PREVIEW_SESSION_INVALID",
	"CONTEXT_PREVIEW_SESSION_IO",
	"CONTEXT_PREVIEW_COMMIT_UNCONFIRMED",
	"CONTEXT_PREVIEW_COMPACT_REQUIRED",
]);

/** Neither provider error text nor model output enters the failure marker or UI. */
export function previewErrorCode(error: unknown, aborted = false): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	const matched = message.slice(0, 256).match(/^(?:CONTEXT|HISTORY)_[A-Z_]{1,40}\b/)?.[0];
	if (matched && (PROJECT_CODES.has(matched) || PREVIEW_CODES.has(matched))) return matched;
	return aborted ? "CONTEXT_COMPACTION_CANCELLED" : "CONTEXT_WRITER_FAILED";
}

/** Notification failures must never turn a cancelled compaction into stock fallback. */
export function reportPreviewError(
	ctx: ExtensionContext,
	code: string,
	durable = true,
	reason?: InactiveReason,
	version = VERSION,
): void {
	notify(ctx, blockedNotice(code, durable, reason, version), "error");
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
export function assertRecoveryEdits(branch: readonly SessionEntry[]): void {
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

export function isPreviewCheckpoint(entry: SessionEntry): entry is CompactionEntry {
	return (
		entry.type === "compaction" &&
		isRecord(entry.details) &&
		entry.details.kind === CONTEXT_MEMORY_KIND &&
		typeof entry.details.build === "string" &&
		entry.details.build.startsWith("stock-preview")
	);
}

/** Host or session content this preview cannot check. Read-only: no IO beyond the session object. */
export function unsupportedReason(session: PreviewSession, version: string = VERSION): InactiveReason | undefined {
	if (version !== SUPPORTED_PI) return "host";
	if (!session.getSessionFile()) return "in-memory";
	const branch = session.getBranch();
	try {
		assertRecoveryEdits(branch);
	} catch {
		return "context-edit";
	}
	if (branch.some((entry) => entry.type === "compaction" && !isPreviewCheckpoint(entry))) return "foreign-checkpoint";
	for (const entry of branch) {
		if (entry.type === "message" && "content" in entry.message && Array.isArray(entry.message.content)) {
			if (entry.message.content.some((part) => part.type === "image")) return "image";
		}
		if (entry.type === "custom_message" && Array.isArray(entry.content)) {
			if (entry.content.some((part) => part.type !== "text")) return "non-text";
		}
	}
	return undefined;
}

const UNSUPPORTED_ERRORS: Record<InactiveReason, string> = {
	host: `CONTEXT_PREVIEW_UNSUPPORTED: this preview is validated only on official Pi ${SUPPORTED_PI}`,
	"in-memory": "CONTEXT_PREVIEW_UNSUPPORTED: a persistent session is required",
	"context-edit": "CONTEXT_PREVIEW_UNSUPPORTED: only failed-response recovery omissions are supported",
	"foreign-checkpoint":
		"CONTEXT_MIGRATION_REQUIRED: start a new preview session; existing checkpoints are not migrated",
	image: "CONTEXT_PREVIEW_UNSUPPORTED: image-bearing sessions are not supported by this preview",
	"non-text": "CONTEXT_PREVIEW_UNSUPPORTED: non-text custom messages are not supported",
};

/** The preview neither migrates existing checkpoints nor accepts a second compactor's summary. */
export function assertPreviewSession(
	session: PreviewSession,
	version: string = VERSION,
	branch?: readonly SessionEntry[],
	onSerializedEntry?: (index: number, serialized: string) => void,
): ReturnType<typeof latestMemory> {
	const reason = unsupportedReason(session, version);
	if (reason) throw new Error(UNSUPPORTED_ERRORS[reason]);
	return validateMemoryCheckpoints(branch ?? session.getBranch(), onSerializedEntry);
}

export interface PreviewControllerOptions {
	config?: Readonly<MemoryConfig>;
	failureStore: PreviewFailureStoreContract;
	/** Config parse errors still install cancellation and request guards. */
	configError?: string;
	/** The running Pi version; tests substitute other releases. */
	hostVersion?: string;
	preparation?: PreviewPreparationCoordinator;
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
	private readonly compactionStartedAt = new Map<string, number>();
	readonly hostVersion: string;
	private activeTools: () => Tool[] = () => [];
	private lastProgress?: WriterProgress;
	readonly notices = new NoticeGate();
	private readonly preparation?: PreviewPreparationCoordinator;
	private lastCompaction?: {
		path: "complete" | "merge" | "sync";
		candidateId?: string;
		foregroundCalls: number;
		stageMs: number;
		pauseMs?: number;
		diskConfirmed: boolean;
	};

	constructor(options: PreviewControllerOptions) {
		this.config = options.config;
		this.store = options.failureStore;
		this.configError = options.configError;
		this.hostVersion = options.hostVersion ?? VERSION;
		this.preparation = options.preparation;
	}

	bindTools(tools: () => Tool[]): void {
		this.activeTools = tools;
	}

	private preparationSubmission(ctx: ExtensionContext, customInstructions?: string): PreparationSubmission {
		if (!this.config || !ctx.model || !this.preparation) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
		const model = resolveWriterModel(this.config, ctx.modelRegistry, ctx.model);
		const branch = ctx.sessionManager.getBranch();
		const previous = latestMemory(branch);
		const projection = ctx.sessionManager.buildSessionProjection();
		const budget = memoryBudget(ctx.model, this.config);
		const cut = chooseCut(branch, budget.recentTokens, projection);
		const active = new Set(
			projection.entries.filter((entry) => entry.messages.length).map((entry) => entry.sourceEntry.id),
		);
		return {
			sessionId: ctx.sessionManager.getSessionId(),
			epoch: this.preparation.currentEpoch,
			branch,
			writer: {
				role: this.config.writerModel === SESSION_WRITER ? "session" : "fixed",
				model: modelName(model),
				effort: writerReasoning(model, this.config, ctx.thinkingLevel),
				policyHash: hashEntries([
					{ writerModel: this.config.writerModel, writerEffort: this.config.writerEffort, model },
				]),
				...writerContractHashes(PREVIEW_BUILD_ID),
				contextHash:
					this.config.writerModel === SESSION_WRITER
						? hashEntries([ctx.getSystemPrompt(), this.activeTools()])
						: null,
			},
			noteBudget: selectNoteBudget(
				this.config,
				budget.threshold,
				compactedSourceTokens(branch.slice(0, cut).filter((entry) => active.has(entry.id))),
				previous ? Math.ceil(noteBytes(previous.memory.note) / 3) : 0,
			),
			customInstructions,
		};
	}

	/** A public settled-turn event only schedules work; no commit state is entered here. */
	prepare(ctx: ExtensionContext): void {
		if (!this.preparation?.enabled || !this.config || !ctx.model) return;
		try {
			const lastCheckpointId =
				[...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "compaction")?.id ?? null;
			if (this.preparation.shouldSkipPreparation(ctx.sessionManager.getSessionId(), lastCheckpointId)) return;
			if (this.safeInactive(ctx) || this.configError || ctx.hasPendingMessages()) return;
			assertPreviewSession(ctx.sessionManager, this.hostVersion);
			if (
				this.store.inspect(ctx.sessionManager).state !== "ready" ||
				this.stickyFailures.has(ctx.sessionManager.getSessionId())
			)
				return;
			const projection = ctx.sessionManager.buildSessionProjection();
			assertToolPairs(projection.messages);
			const last = [...projection.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "assistant" || !(last.stopReason === "stop" || last.stopReason === "length")) return;
			this.preparation.activate(ctx.sessionManager.getSessionId());
			const submission = this.preparationSubmission(ctx);
			const branch = structuredClone(ctx.sessionManager.getBranch());
			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) return;
			const previous = latestMemory(branch);
			const after = previous ? branch.findIndex((entry) => entry.id === previous.memory.coveredThrough) : -1;
			const uncovered = branch.slice(after + 1);
			const newSourceTokens = compactedSourceTokens(uncovered);
			const input = freezePreparationInput({
				...submission,
				branch,
				coveredThrough: leafId,
				processedUserEntryIds: branch
					.filter((entry) => entry.type === "message" && entry.message.role === "user")
					.map((entry) => entry.id),
			});
			const model = structuredClone(resolveWriterModel(this.config, ctx.modelRegistry, ctx.model));
			const sessionModel = structuredClone(ctx.model);
			const registry = ctx.modelRegistry;
			const capturedRegistry = {
				find: (provider: string, id: string) =>
					provider === model.provider && id === model.id ? model : undefined,
				hasConfiguredAuth: registry.hasConfiguredAuth.bind(registry),
				streamSimple: registry.streamSimple.bind(registry),
			};
			const increments = noteIncrements(branch, previous?.entry.id);
			const messages = structuredClone(convertToLlm(projection.messages));
			const prefix = getInitialSystemMessage(messages)
				? { messages }
				: { messages, systemPrompt: ctx.getSystemPrompt(), tools: structuredClone(this.activeTools()) };
			const config = { ...this.config, noteRepair: false };
			const thinking = ctx.thinkingLevel;
			this.preparation.start({
				input,
				newSourceTokens,
				run: (signal, callHooks) =>
					writeMemory({
						config,
						registry: capturedRegistry,
						sessionModel,
						sessionThinkingLevel: thinking,
						prefix: config.writerModel === SESSION_WRITER ? prefix : undefined,
						previous: previous?.memory.note,
						increments,
						uncovered,
						branch,
						noteTokens: submission.noteBudget.hardTokens,
						baseNoteTokens: submission.noteBudget.baseTokens,
						signal,
						callHooks,
					}),
			});
		} catch {
			// Optional work must never call fail(), begin() or abort the user's task.
		}
	}

	invalidatePreparation(reason: string): void {
		this.preparation?.invalidate(reason);
	}

	shutdownPreparation(): void {
		this.preparation?.dispose();
	}

	/**
	 * A session is protected once this package has written a checkpoint for it or recorded a pending
	 * or failed attempt. Those durable claims, never content alone, decide strict blocking.
	 */
	protected(ctx: ExtensionContext): boolean {
		const session = ctx.sessionManager;
		const sessionId = session.getSessionId();
		return (
			this.stickyFailures.has(sessionId) ||
			this.activeCompactions.has(sessionId) ||
			session.getEntries().some(isPreviewCheckpoint) ||
			this.store.markerPresent(session)
		);
	}

	/** The reason this preview stands aside, for a session it does not protect and cannot check. */
	inactive(ctx: ExtensionContext): InactiveReason | undefined {
		const reason = unsupportedReason(ctx.sessionManager, this.hostVersion);
		return reason && !this.protected(ctx) ? reason : undefined;
	}

	/** Request paths fail closed: if classification itself fails, the ordinary guards decide. */
	safeInactive(ctx: ExtensionContext): InactiveReason | undefined {
		try {
			return this.inactive(ctx);
		} catch {
			return undefined;
		}
	}

	/** Read-only: calls no model, writes no marker and latches no failure. */
	diagnose(ctx: ExtensionContext): PreviewDiagnosis {
		const session = ctx.sessionManager;
		const reason = unsupportedReason(session, this.hostVersion);
		const isProtected = this.protected(ctx);
		const inactive = reason !== undefined && !isProtected;
		let checkpointId: string | undefined;
		let state: PreviewDiagnosis["state"] = "inactive";
		let code: string | undefined;
		if (!inactive) {
			const stored = this.store.inspect(session);
			state = stored.state;
			code = this.configError ?? this.stickyFailures.get(session.getSessionId()) ?? stored.code;
			try {
				assertPreviewSession(session, this.hostVersion);
				checkpointId = latestMemory(session.getBranch())?.entry.id;
			} catch (error) {
				code = previewErrorCode(error);
			}
			if (code && code !== stored.code) state = "blocked";
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
		let contextTokens: number | null = null;
		try {
			contextTokens = ctx.getContextUsage()?.tokens ?? null;
		} catch {
			// Usage is advisory and may be unavailable before the first response.
		}
		const last = [...session.buildSessionProjection().messages]
			.reverse()
			.find((message) => message.role !== "system");
		const turnComplete =
			last?.role === "assistant" &&
			(last.stopReason === "stop" || last.stopReason === "length") &&
			!ctx.hasPendingMessages();
		return {
			build: PREVIEW_BUILD_ID,
			host: this.hostVersion,
			supportedHost: SUPPORTED_PI,
			protection: inactive ? "not-protected" : isProtected ? "protected" : "eligible",
			...(reason ? { reason } : {}),
			state,
			...(code ? { code } : {}),
			writer,
			writerError,
			checkpointId,
			manualCompaction: {
				preview: inactive
					? "not-active"
					: state !== "ready"
						? "blocked"
						: turnComplete
							? "ready"
							: "waiting-for-turn",
				pi: "unknown",
				contextTokens,
				piDefaultKeepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
			},
		};
	}

	/** Machine-readable status. Earlier fields keep their names; protection and eligibility are additions. */
	status(ctx: ExtensionContext) {
		const diagnosis = this.diagnose(ctx);
		let prepared: ReturnType<PreviewPreparationCoordinator["status"]> | undefined;
		if (this.preparation) {
			try {
				prepared = this.preparation.status(this.preparation.enabled ? this.preparationSubmission(ctx) : undefined);
			} catch {
				prepared = { ...this.preparation.status(), state: "paused", reason: "writer-or-source-unavailable" };
			}
		}
		return {
			build: diagnosis.build,
			enabled: this.config?.enabled ?? true,
			state: diagnosis.state,
			...(diagnosis.code ? { code: diagnosis.code } : {}),
			writerModel: this.config?.writerModel,
			writer: diagnosis.writer,
			writerError: diagnosis.writerError,
			checkpointId: diagnosis.checkpointId,
			noteBudgetMode: this.config?.noteTokens === undefined ? "tiered" : "fixed",
			noteRepair: this.config?.noteRepair,
			manualOnly: true,
			lastWriter: this.lastProgress,
			host: diagnosis.host,
			supportedHost: diagnosis.supportedHost,
			protection: diagnosis.protection,
			...(diagnosis.reason ? { reason: diagnosis.reason } : {}),
			manualCompaction: diagnosis.manualCompaction,
			...(prepared ? { preparation: prepared } : {}),
			...(this.lastCompaction ? { lastCompaction: this.lastCompaction } : {}),
		};
	}

	assertReady(ctx: ExtensionContext): ReturnType<typeof latestMemory> {
		if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
		const branch = ctx.sessionManager.getBranch();
		const factory = createPreviewBranchSnapshot(branch);
		const checkpoint = assertPreviewSession(ctx.sessionManager, this.hostVersion, branch, factory?.onSerializedEntry);
		const sticky = this.stickyFailures.get(ctx.sessionManager.getSessionId());
		if (sticky) throw new Error(sticky);
		// There is no await or handler dispatch between serialization and this fresh disk check.
		this.store.assertReady(ctx.sessionManager, factory?.snapshot);
		return checkpoint;
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

	/** At most one blocking notice per session for each user input or manual compaction attempt. */
	reportBlocked(ctx: ExtensionContext, code: string, durable = true): void {
		try {
			if (!this.notices.blockedOnce(ctx.sessionManager.getSessionId())) return;
			reportPreviewError(
				ctx,
				code,
				durable,
				unsupportedReason(ctx.sessionManager, this.hostVersion),
				this.hostVersion,
			);
		} catch {
			// Notices are advisory; the abort and any marker have already taken effect.
		}
	}

	/** Called once per session start: one short notice, never a marker for a session the preview does not protect. */
	sessionStart(ctx: ExtensionContext): void {
		this.preparation?.activate(ctx.sessionManager.getSessionId());
		if (this.preparation?.enabled) {
			try {
				assertPreviewSession(ctx.sessionManager, this.hostVersion);
				const claims = ctx.sessionManager.getBranch().flatMap((entry) => {
					if (entry.type !== "compaction" || !isRecord(entry.details)) return [];
					const prep = entry.details.preparation;
					return isRecord(prep) &&
						typeof prep.candidateId === "string" &&
						Array.isArray(prep.callIds) &&
						prep.callIds.every((id) => typeof id === "string")
						? [{ candidateId: prep.candidateId, callIds: prep.callIds as string[] }]
						: [];
				});
				this.preparation.reconcile(
					ctx.sessionManager.getSessionId(),
					claims,
					this.store.inspect(ctx.sessionManager).state === "ready",
				);
			} catch {
				// Optional accounting reconciliation cannot change core protection or start a writer.
			}
		}
		const reason = this.safeInactive(ctx);
		if (reason) {
			this.standAside(ctx, reason);
			return;
		}
		if (this.guard(ctx, () => this.assertReady(ctx)) && this.notices.once("ready")) {
			notify(ctx, readyNotice(PREVIEW_BUILD_ID), "info");
		}
	}

	/** The preview leaves this session to Pi; say so once per session and process. */
	standAside(ctx: ExtensionContext, reason: InactiveReason): void {
		if (this.notices.once(`inactive:${ctx.sessionManager.getSessionId()}:${reason}`)) {
			notify(ctx, inactiveNotice(reason, this.hostVersion), "info");
		}
	}

	/**
	 * Stock Pi catches extension exceptions: abort is necessary before reporting any guard failure.
	 * A protected session records the failure durably; for a session the preview has not enrolled,
	 * only the current request is stopped and the check runs again next time.
	 */
	guard(ctx: ExtensionContext, operation: () => void): boolean {
		try {
			operation();
			return true;
		} catch (error) {
			const code = previewErrorCode(error);
			let durable = true;
			try {
				durable = this.protected(ctx);
			} catch {
				// An unclassifiable session is treated as protected, so the failure is recorded.
			}
			if (durable) this.fail(ctx, code);
			ctx.abort();
			this.reportBlocked(ctx, code, durable);
			return false;
		}
	}

	context(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] {
		const reason = this.safeInactive(ctx);
		if (reason) {
			this.standAside(ctx, reason);
			return messages;
		}
		this.guard(ctx, () => {
			const checkpoint = this.assertReady(ctx);
			if (!ctx.model || !this.config) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
			if (checkpoint) {
				const restored = messages.filter((message) => message.role === "compactionSummary");
				if (restored.length !== 1 || restored[0].summary !== checkpoint.entry.summary) {
					throw new Error("CONTEXT_RECOVERY_MISSING: the validated checkpoint is missing from model context");
				}
			}
			assertToolPairs(messages);
			const estimate =
				messages.reduce((sum, message) => sum + estimateTokens(message), 0) +
				(getInitialSystemMessage(messages) ? 0 : textTokens(ctx.getSystemPrompt()));
			if (estimate > memoryBudget(ctx.model, this.config).inputLimit) throw new Error("CONTEXT_INPUT_TOO_LARGE");
		});
		// Note candidates already appear in context as the model's own tool calls. Re-injecting them
		// under another role would change their authority and invalidate the provider prefix cache.
		return messages;
	}

	beforeRequest(payload: unknown, ctx: ExtensionContext): void {
		if (this.safeInactive(ctx)) return;
		this.guard(ctx, () => {
			const checkpoint = this.assertReady(ctx);
			if (!ctx.model || !this.config) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
			const serialized = JSON.stringify(payload);
			if (checkpoint && !serialized?.includes(JSON.stringify(checkpoint.entry.summary).slice(1, -1))) {
				throw new Error("CONTEXT_RECOVERY_MISSING: the provider payload lost the validated checkpoint");
			}
			if (textTokens(serialized ?? "") > memoryBudget(ctx.model, this.config).inputLimit) {
				throw new Error("CONTEXT_PAYLOAD_TOO_LARGE");
			}
		});
	}

	async compact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<PreviewCompaction> {
		const started = performance.now();
		this.compactionStartedAt.set(ctx.sessionManager.getSessionId(), started);
		this.preparation?.cancel("compaction");
		this.activeCompactions.add(ctx.sessionManager.getSessionId());
		this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
		try {
			if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
			assertPreviewSession(ctx.sessionManager, this.hostVersion);
			if (event.reason !== "manual" || event.willRetry) {
				throw new Error("CONTEXT_PREVIEW_COMPACT_REQUIRED: this preview compacts only on an explicit /compact");
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
			const prefixMessages = convertToLlm(projectedMessages);
			assertToolPairs(prefixMessages);
			const sessionWriter = this.config.writerModel === SESSION_WRITER;
			const prefix = getInitialSystemMessage(prefixMessages)
				? { messages: prefixMessages }
				: { systemPrompt: ctx.getSystemPrompt(), messages: prefixMessages, tools: this.activeTools() };
			this.lastProgress = undefined;
			const submission = this.preparation?.enabled
				? { ...this.preparationSubmission(ctx, event.customInstructions), noteBudget: policy }
				: undefined;
			const available = submission ? this.preparation?.available(submission) : undefined;
			const path = available?.classification.status === "current-full" ? "complete" : available ? "merge" : "sync";
			const prepared = available?.result.candidate;
			let written: WriteMemoryResult;
			if (path === "complete" && available) {
				const note = validateNote(structuredClone(available.result.written.note), branch, policy.hardTokens);
				written = { ...available.result.written, note, usage: sumMemoryUsage([]), chunkCount: 0 };
				this.lastProgress = {
					writerModel: written.writerModel,
					writerEffort: written.writerEffort,
					writerCalls: 0,
					usageReports: 0,
					repairUsed: false,
					writerCallDetails: [],
				};
			} else {
				const covered = prepared
					? branch.findIndex((entry) => entry.id === prepared.input.coverage.coveredThrough)
					: after;
				let uncovered = branch.slice(covered + 1);
				// New focus or tighter budgets may require a rewrite without a readable tail.
				if (!uncovered.some((entry) => compactedSourceTokens([entry]) > 0)) uncovered = branch.slice(after + 1);
				const frozen =
					submission && this.preparation
						? freezePreparationInput({
								...submission,
								coveredThrough: attempt.leafId,
								processedUserEntryIds: branch
									.filter((entry) => entry.type === "message" && entry.message.role === "user")
									.map((entry) => entry.id),
							})
						: undefined;
				written = await writeMemory({
					config: this.config,
					registry: ctx.modelRegistry,
					sessionModel: ctx.model,
					prefix: sessionWriter ? prefix : undefined,
					sessionThinkingLevel: sessionWriter ? ctx.thinkingLevel : undefined,
					previous: available ? structuredClone(available.result.written.note) : previous?.memory.note,
					increments,
					uncovered,
					branch,
					noteTokens: policy.hardTokens,
					baseNoteTokens: policy.baseTokens,
					signal: event.signal,
					customInstructions: event.customInstructions,
					callHooks: frozen
						? this.preparation?.foregroundHooks(frozen, path === "merge" ? "merge" : "sync")
						: undefined,
					onProgress: (progress) => {
						this.lastProgress = progress;
					},
				});
			}
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
					...(this.preparation?.enabled
						? {
								preparation: {
									version: 1 as const,
									strategy: "background" as const,
									path,
									...(prepared
										? { candidateId: prepared.input.candidateId, callIds: [...prepared.provenance.callIds] }
										: {}),
								},
							}
						: {}),
				},
			};
			this.store.stage(ctx.sessionManager, attempt, candidate);
			this.preparation?.checkpointStaged(prepared?.input.candidateId);
			this.stagedCompactions.add(attempt.sessionId);
			this.lastCompaction = {
				path,
				...(prepared ? { candidateId: prepared.input.candidateId } : {}),
				foregroundCalls: this.lastProgress?.writerCalls ?? 0,
				stageMs: Math.round(performance.now() - started),
				diskConfirmed: false,
			};
			return candidate;
		} catch (error) {
			const code = previewErrorCode(error, event.signal.aborted);
			this.compactionStartedAt.delete(ctx.sessionManager.getSessionId());
			this.fail(ctx, code);
			throw new Error(code);
		}
	}

	committed(event: SessionCompactEvent, ctx: ExtensionContext): void {
		const ours = this.activeCompactions.delete(ctx.sessionManager.getSessionId());
		this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
		// Pi's own compaction of a session this preview does not protect is not a commit of this package.
		if (!ours && !this.protected(ctx)) return;
		try {
			assertPreviewSession(ctx.sessionManager, this.hostVersion);
			const memory = latestMemory(ctx.sessionManager.getBranch());
			if (!event.fromExtension || memory?.entry.id !== event.compactionEntry.id) {
				throw new Error("CONTEXT_PREVIEW_COMMIT_UNCONFIRMED");
			}
			// The marker owner reads the exact checkpoint and sources back from persistent JSONL.
			this.store.commit(ctx.sessionManager, event.compactionEntry);
			const started = this.compactionStartedAt.get(ctx.sessionManager.getSessionId());
			this.compactionStartedAt.delete(ctx.sessionManager.getSessionId());
			if (this.lastCompaction) {
				this.lastCompaction.diskConfirmed = true;
				if (started !== undefined) this.lastCompaction.pauseMs = Math.round(performance.now() - started);
			}
			const prep = event.compactionEntry.details;
			if (
				isRecord(prep) &&
				isRecord(prep.preparation) &&
				typeof prep.preparation.candidateId === "string" &&
				Array.isArray(prep.preparation.callIds) &&
				prep.preparation.callIds.every((id) => typeof id === "string")
			) {
				this.preparation?.confirmCommitted(
					ctx.sessionManager.getSessionId(),
					prep.preparation.candidateId,
					prep.preparation.callIds as string[],
				);
			}
			this.preparation?.checkpointCommitted();
			this.stickyFailures.delete(ctx.sessionManager.getSessionId());
			this.observedFailures.delete(ctx.sessionManager.getSessionId());
		} catch (error) {
			const code = previewErrorCode(error);
			this.fail(ctx, code);
			ctx.abort();
			this.reportBlocked(ctx, code);
		}
	}

	/**
	 * Reconcile a staged checkpoint that Pi saved but whose commit observation was interrupted.
	 * Only an existing pending or blocked record can be confirmed; a refusal never creates one,
	 * and failures inside the confirmation are recorded by the failure store itself.
	 */
	recover(ctx: ExtensionContext): void {
		try {
			if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
			assertPreviewSession(ctx.sessionManager, this.hostVersion);
			const leaf = ctx.sessionManager.getLeafEntry();
			const memory = latestMemory(ctx.sessionManager.getBranch());
			if (
				leaf?.type !== "compaction" ||
				memory?.entry.id !== leaf.id ||
				!this.store.markerPresent(ctx.sessionManager)
			) {
				throw new Error("CONTEXT_PREVIEW_COMMIT_UNCONFIRMED");
			}
			this.store.recover(ctx.sessionManager, leaf);
			const details = leaf.details;
			if (
				isRecord(details) &&
				isRecord(details.preparation) &&
				typeof details.preparation.candidateId === "string" &&
				Array.isArray(details.preparation.callIds) &&
				details.preparation.callIds.every((id) => typeof id === "string")
			) {
				this.preparation?.confirmCommitted(
					ctx.sessionManager.getSessionId(),
					details.preparation.candidateId,
					details.preparation.callIds as string[],
				);
			}
			this.preparation?.checkpointCommitted();
			this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
			this.stickyFailures.delete(ctx.sessionManager.getSessionId());
			this.observedFailures.delete(ctx.sessionManager.getSessionId());
		} catch (error) {
			throw new Error(previewErrorCode(error));
		}
	}

	compactionFailed(event: SessionCompactFailedEvent, ctx: ExtensionContext): void {
		this.compactionStartedAt.delete(ctx.sessionManager.getSessionId());
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
		this.reportBlocked(ctx, code);
	}
}
