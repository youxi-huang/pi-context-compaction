import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getInitialSystemMessage, type Tool } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type CompactionEntry,
	convertToLlm,
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionContext,
	estimateTokens,
	type InputEvent,
	type InputEventResult,
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
	renderNote,
	shrinkLineage,
	validateMemoryCheckpoints,
	validateNote,
} from "../notes.ts";
import { PREVIEW_BUILD_ID } from "./build.ts";
import type { CallJournal } from "./call-journal.ts";
import { PRIMARY_PI_VERSION, SUPPORTED_PI_LABEL, SUPPORTED_PI_VERSIONS, supportsPi } from "./compatibility.ts";
import type {
	InactiveReason,
	NotesFallback,
	PreviewCompaction,
	PreviewDiagnosis,
	PreviewFailureStoreContract,
	PreviewReadback,
	PreviewSession,
} from "./contracts.ts";
import { blockedNotice, inactiveNotice, NoticeGate, notify, readyNotice } from "./notices.ts";
import type { PreviewPreparation, PreviewSwitch } from "./preparation.ts";
import { freezePreparationInput, type PreparationSubmission, reusablePrefix } from "./preparation-candidate.ts";
import { setStatusLine } from "./status-line.ts";
import {
	assertUserMessages,
	carriedUserMessages,
	coveredUserMessages,
	mergeWorkNotes,
	renderUserMessages,
	workNotes,
	writerSources,
} from "./work-notes.ts";
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
	repeated = false,
): void {
	notify(ctx, blockedNotice(code, durable, reason, version, repeated), repeated ? "warning" : "error");
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

/**
 * Keep complete recent turns; a zero budget uses stock Pi's no-matching-kept-entry convention. The cut
 * follows the previous checkpoint: stock Pi keeps every entry from the cut onwards, so an earlier
 * checkpoint inside that range would reappear as a second summary.
 */
export function chooseCut(
	branch: readonly SessionEntry[],
	keepRecentTokens: number,
	projection: SessionProjection = buildSessionProjection([...branch]),
): number {
	if (keepRecentTokens <= 0) return branch.length;
	const projected = new Map(projection.entries.map((entry) => [entry.sourceEntry.id, entry.messages]));
	const previous = branch.findLastIndex((entry) => entry.type === "compaction");
	const starts = branch.flatMap((entry, index) =>
		index > previous && entry.type === "message" && entry.message.role === "user" && projected.get(entry.id)?.length
			? [index]
			: [],
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

/**
 * The latest turn start at or before `coveredIndex + 1` and `cut`, so that only covered entries leave
 * context. It must follow the previous checkpoint: stock Pi keeps every entry from the cut onwards,
 * so an earlier checkpoint inside that range would reappear as a second summary.
 */
export function prefixCut(
	branch: readonly SessionEntry[],
	projection: SessionProjection,
	coveredIndex: number,
	cut: number,
): number | undefined {
	const previous = branch.findLastIndex((entry) => entry.type === "compaction");
	const projected = new Set(
		projection.entries.filter((entry) => entry.messages.length).map((entry) => entry.sourceEntry.id),
	);
	for (let index = Math.min(cut, coveredIndex + 1); index > previous; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "user" && projected.has(entry.id)) return index;
	}
	return undefined;
}

/** The interval a preparation belongs to: the latest checkpoint on the branch, or none yet. */
export function checkpointInterval(branch: readonly SessionEntry[]): string {
	return branch.findLast((entry) => entry.type === "compaction")?.id ?? "none";
}

/**
 * Context size at which optional preparation starts: a band below Pi's default threshold compaction point,
 * 12.5% of it and between 8,192 and 32,768 tokens. Pi's own compaction settings are not visible to extensions.
 */
export function preparationStart(contextWindow: number): number {
	const threshold = contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	return threshold - Math.min(32_768, Math.max(8_192, Math.floor(threshold * 0.125)));
}

/** Pi's own token estimate, four characters per token, so the request guards and Pi's threshold share a scale. */
function piTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * The request guard's limit: Pi's threshold, window minus Pi's default reserve. Pi compacts above it after a
 * turn or before a prompt, so a request below it is never stopped. The model's output maximum does not lower it.
 */
export function requestLimit(model: { contextWindow: number }): number {
	const limit = model.contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	if (!Number.isFinite(limit) || limit < 2048)
		throw new Error("CONTEXT_CAPACITY: model window is too small or unknown");
	return limit;
}

/** The checkpoint text, shortening lineage until it fits `limit` beside the retained context. */
function fittedSummary(
	note: MemoryNote,
	branch: readonly SessionEntry[],
	retainedTokens: number,
	limit: number,
	userMessages = "",
): string | undefined {
	let lineage = checkpointLineage(branch);
	let summary = renderNote(note, lineage) + userMessages;
	while (lineage.length && textTokens(summary) + retainedTokens > limit) {
		lineage = shrinkLineage(lineage);
		summary = renderNote(note, lineage) + userMessages;
	}
	return textTokens(summary) + retainedTokens > limit ? undefined : summary;
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

/** Entry content this preview cannot check. */
function unsupportedContent(entry: SessionEntry): InactiveReason | undefined {
	if (entry.type === "message" && "content" in entry.message && Array.isArray(entry.message.content)) {
		if (entry.message.content.some((part) => part.type === "image")) return "image";
	}
	if (entry.type === "custom_message" && Array.isArray(entry.content)) {
		if (entry.content.some((part) => part.type !== "text")) return "non-text";
	}
	return undefined;
}

/** Host or session content this preview cannot check. Read-only: no IO beyond the session object. */
export function unsupportedReason(session: PreviewSession, version: string = VERSION): InactiveReason | undefined {
	if (!supportsPi(version)) return "host";
	if (!session.getSessionFile()) return "in-memory";
	const branch = session.getBranch();
	try {
		assertRecoveryEdits(branch);
	} catch {
		return "context-edit";
	}
	if (branch.some((entry) => entry.type === "compaction" && !isPreviewCheckpoint(entry))) return "foreign-checkpoint";
	for (const entry of branch) {
		const reason = unsupportedContent(entry);
		if (reason) return reason;
	}
	return undefined;
}

const UNSUPPORTED_ERRORS: Record<InactiveReason, string> = {
	host: `CONTEXT_PREVIEW_UNSUPPORTED: this preview is validated on official Pi ${SUPPORTED_PI_LABEL}`,
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
	const sources = branch ?? session.getBranch();
	const latest = validateMemoryCheckpoints(sources, onSerializedEntry);
	assertUserMessages(sources);
	return latest;
}

function assertHashedPreviewSession(session: PreviewSession, version: string, branch?: readonly SessionEntry[]) {
	const hash = createHash("sha256");
	const checkpoint = assertPreviewSession(session, version, branch, (_index, serialized) => {
		hash.update(serialized).update("\n");
	});
	return { checkpoint, sourceHash: hash.digest("hex") };
}

/** What the last full source validation proved, reused only while the same entry objects extend it. */
interface VerifiedBranch {
	session: PreviewSession;
	sessionId: string;
	length: number;
	tip: SessionEntry | undefined;
	checkpoint: ReturnType<typeof latestMemory>;
}

export interface PreviewControllerOptions {
	config?: Readonly<MemoryConfig>;
	failureStore: PreviewFailureStoreContract;
	/** Config parse errors still install cancellation and request guards. */
	configError?: string;
	/** The running Pi version; tests substitute other releases. */
	hostVersion?: string;
	preparation?: PreviewPreparation;
	/** Records every writer call; without one, calls are observed only in memory. */
	journal?: CallJournal;
	/** Arm B: commit merged work notes without a writer call when the prefix path allows it. */
	workNotes?: PreviewSwitch;
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
	/** Per session, like every other state here, so status never mixes one session's calls with another's metrics. */
	private readonly lastProgress = new Map<string, WriterProgress>();
	private verified?: VerifiedBranch;
	private pendingSessionNotice?: { sessionId: string; key: string; text: string };
	readonly notices = new NoticeGate();
	private readonly preparation?: PreviewPreparation;
	private readonly journal?: CallJournal;
	private readonly workNotes: PreviewSwitch;
	private readonly lastCompaction = new Map<
		string,
		{
			path: "complete" | "prefix" | "notes" | "sync";
			candidateId?: string;
			foregroundCalls: number;
			stageMs: number;
			pauseMs?: number;
			diskConfirmed: boolean;
		}
	>();

	constructor(options: PreviewControllerOptions) {
		this.config = options.config;
		this.store = options.failureStore;
		this.configError = options.configError;
		this.hostVersion = options.hostVersion ?? VERSION;
		this.preparation = options.preparation;
		this.journal = options.journal;
		this.workNotes = options.workNotes ?? { enabled: false };
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

	/**
	 * A settled turn may start optional preparation, once per checkpoint interval, when the context has entered
	 * the band just below Pi's compaction threshold. No commit state is entered here.
	 */
	prepare(ctx: ExtensionContext): void {
		if (!this.preparation?.enabled || !this.config || !ctx.model) return;
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const interval = checkpointInterval(ctx.sessionManager.getBranch());
			if (!this.preparation.mayStart(sessionId, interval)) return;
			const usage = ctx.getContextUsage();
			if (!usage?.tokens || usage.tokens < preparationStart(usage.contextWindow)) return;
			if (this.safeInactive(ctx) || this.configError || ctx.hasPendingMessages()) return;
			assertPreviewSession(ctx.sessionManager, this.hostVersion);
			if (this.store.inspect(ctx.sessionManager).state !== "ready" || this.stickyFailures.has(sessionId)) return;
			const projection = ctx.sessionManager.buildSessionProjection();
			assertToolPairs(projection.messages);
			const last = [...projection.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "assistant" || !(last.stopReason === "stop" || last.stopReason === "length")) return;
			this.preparation.activate(sessionId);
			const submission = this.preparationSubmission(ctx);
			const branch = structuredClone(ctx.sessionManager.getBranch());
			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) return;
			const previous = latestMemory(branch);
			const uncovered = writerSources(branch, previous);
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
			const increments = workNotes(branch, previous?.memory.coveredThrough).map((item) => item.note);
			const messages = structuredClone(convertToLlm(projection.messages));
			const prefix = getInitialSystemMessage(messages)
				? { messages }
				: { messages, systemPrompt: ctx.getSystemPrompt(), tools: structuredClone(this.activeTools()) };
			const config = { ...this.config, noteRepair: false };
			const thinking = ctx.thinkingLevel;
			this.preparation.start(
				{
					input,
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
				},
				interval,
			);
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
		// compact() runs the same configuration and session checks first, so a failure here is not retryable.
		let compactCannotClear = false;
		let recover = false;
		if (!inactive) {
			const stored = this.store.inspect(session);
			state = stored.state;
			code = this.configError ?? this.stickyFailures.get(session.getSessionId()) ?? stored.code;
			compactCannotClear = this.configError !== undefined || !this.config;
			try {
				assertPreviewSession(session, this.hostVersion);
				const latest = latestMemory(session.getBranch());
				checkpointId = latest?.entry.id;
				// The conditions recover() checks before its readback: a staged checkpoint at the leaf and a record.
				const leaf = session.getLeafEntry();
				recover =
					state !== "ready" &&
					leaf?.type === "compaction" &&
					latest?.entry.id === leaf.id &&
					this.store.markerPresent(session);
			} catch (error) {
				code = previewErrorCode(error);
				compactCannotClear = true;
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
		const idle = !ctx.hasPendingMessages();
		const completed = last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
		// compact() also accepts a turn that ended in an error, an abort or unanswered input when it retries.
		const terminated =
			last?.role === "user" ||
			(last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted"));
		let manual: PreviewDiagnosis["manualCompaction"]["preview"];
		if (inactive) manual = "not-active";
		else if (compactCannotClear || writerError) manual = "blocked";
		else if (state === "ready") manual = completed && idle ? "ready" : "waiting-for-turn";
		else manual = (completed || terminated) && idle ? "retry" : "waiting-for-turn";
		return {
			build: PREVIEW_BUILD_ID,
			host: this.hostVersion,
			supportedHost: PRIMARY_PI_VERSION,
			supportedHosts: SUPPORTED_PI_VERSIONS,
			protection: inactive ? "not-protected" : isProtected ? "protected" : "eligible",
			...(reason ? { reason } : {}),
			state,
			...(code ? { code } : {}),
			writer,
			writerError,
			checkpointId,
			manualCompaction: {
				preview: manual,
				recover,
				pi: "unknown",
				contextTokens,
				piDefaultKeepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
			},
		};
	}

	/** Machine-readable status. Earlier fields keep their names; protection and eligibility are additions. */
	status(ctx: ExtensionContext) {
		const diagnosis = this.diagnose(ctx);
		let prepared: ReturnType<PreviewPreparation["status"]> | undefined;
		if (this.preparation) {
			try {
				prepared = this.preparation.status(this.preparation.enabled ? this.preparationSubmission(ctx) : undefined);
			} catch {
				prepared = { ...this.preparation.status(), state: "paused", reason: "writer-or-source-unavailable" };
			}
		}
		const sessionId = ctx.sessionManager.getSessionId();
		const lastCompaction = this.lastCompaction.get(sessionId);
		let calls: ReturnType<CallJournal["summary"]> | undefined;
		try {
			calls = this.journal?.summary(sessionId);
		} catch {
			// The journal is advisory for status; its own gap state is reported when it can be read.
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
			// Threshold compaction after a completed turn is handled; overflow recovery still needs /compact.
			manualOnly: false,
			lastWriter: this.lastProgress.get(sessionId),
			host: diagnosis.host,
			supportedHost: diagnosis.supportedHost,
			supportedHosts: diagnosis.supportedHosts,
			protection: diagnosis.protection,
			...(diagnosis.reason ? { reason: diagnosis.reason } : {}),
			manualCompaction: diagnosis.manualCompaction,
			...(prepared ? { preparation: prepared } : {}),
			...(calls ? { calls } : {}),
			...(lastCompaction ? { lastCompaction } : {}),
		};
	}

	/**
	 * Request guard. Sources and checkpoints are validated in full at trust boundaries: session start, a branch
	 * change, a new checkpoint, compaction, recovery and after any failure. Between them a request checks only
	 * the entries added since, and the store checks the session file's identity and length.
	 */
	assertReady(ctx: ExtensionContext): ReturnType<typeof latestMemory> {
		if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
		const session = ctx.sessionManager;
		const branch = session.getBranch();
		let checkpoint: ReturnType<typeof latestMemory>;
		let serializedBranch: string[] | undefined;
		if (this.verified && this.extendsVerified(this.verified, session, branch)) {
			checkpoint = this.verified.checkpoint;
		} else {
			this.verified = undefined;
			const serialized: string[] = [];
			checkpoint = assertPreviewSession(session, this.hostVersion, branch, (_index, text) => serialized.push(text));
			serializedBranch = serialized;
		}
		const sticky = this.stickyFailures.get(session.getSessionId());
		if (sticky) throw new Error(sticky);
		this.store.assertReady(session, serializedBranch);
		this.verified = {
			session,
			sessionId: session.getSessionId(),
			length: branch.length,
			tip: branch.at(-1),
			checkpoint,
		};
		return checkpoint;
	}

	/** The same entry objects as the last full validation, followed only by ordinary new entries. */
	private extendsVerified(
		verified: VerifiedBranch,
		session: PreviewSession,
		branch: readonly SessionEntry[],
	): boolean {
		if (verified.session !== session || verified.sessionId !== session.getSessionId()) return false;
		if (branch.length < verified.length || branch[verified.length - 1] !== verified.tip) return false;
		for (let index = verified.length; index < branch.length; index++) {
			const entry = branch[index];
			// A new checkpoint, a recovery edit or unsupported content needs the full validation and its error.
			if (entry.type === "compaction" || entry.type === "context_edit" || unsupportedContent(entry)) return false;
		}
		return true;
	}

	/** The next request validates sources and reads the session file back in full. */
	private forgetVerified(): void {
		this.verified = undefined;
		this.store.forgetReadback();
	}

	/** Tree navigation is a trust boundary, even when the selected branch extends the previous one. */
	branchChanged(ctx: ExtensionContext): void {
		this.forgetVerified();
		if (this.stickyFailures.has(ctx.sessionManager.getSessionId())) {
			setStatusLine(ctx, "paused");
		} else if (unsupportedReason(ctx.sessionManager, this.hostVersion)) {
			setStatusLine(ctx, ctx.sessionManager.getEntries().some(isPreviewCheckpoint) ? "paused" : undefined);
		} else if (this.configError || !this.config) {
			setStatusLine(ctx, undefined);
		} else {
			this.readyStatus(ctx);
		}
	}

	private readyStatus(ctx: ExtensionContext): void {
		setStatusLine(ctx, ctx.sessionManager.getBranch().filter(isPreviewCheckpoint).length);
	}

	input(event: InputEvent, ctx: ExtensionContext): InputEventResult | undefined {
		this.notices.nextEpisode();
		this.showSessionNotice(ctx);
		if (event.source !== "interactive" || !ctx.hasUI || event.images?.length) return;
		const code = this.stickyFailures.get(ctx.sessionManager.getSessionId());
		if (!code) return;
		this.reportBlocked(ctx, code);
		ctx.ui.setEditorText(event.text);
		return { action: "handled" };
	}

	/** In-process stickiness covers a marker write that failed before it could reach disk. */
	fail(ctx: ExtensionContext, code: string): void {
		this.pendingSessionNotice = undefined;
		this.forgetVerified();
		const sessionId = ctx.sessionManager.getSessionId();
		this.observedFailures.set(sessionId, code);
		this.stickyFailures.set(sessionId, code);
		setStatusLine(ctx, "paused");
		try {
			this.store.fail(ctx.sessionManager, code);
		} catch (error) {
			this.stickyFailures.set(sessionId, previewErrorCode(error));
		}
	}

	/** At most one blocking notice per session for each user input or manual compaction attempt. */
	reportBlocked(ctx: ExtensionContext, code: string, durable = true): void {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!this.notices.blockedOnce(sessionId)) return;
			reportPreviewError(
				ctx,
				code,
				durable,
				unsupportedReason(ctx.sessionManager, this.hostVersion),
				this.hostVersion,
				durable && this.notices.repeated(sessionId, code),
			);
		} catch {
			// Notices are advisory; the abort and any marker have already taken effect.
		}
	}

	/** Called once per session start: one short notice, never a marker for a session the preview does not protect. */
	sessionStart(ctx: ExtensionContext): void {
		this.pendingSessionNotice = undefined;
		this.forgetVerified();
		this.preparation?.activate(ctx.sessionManager.getSessionId());
		// Pi's startup compaction status overwrites informational notices, including earlier rows.
		const deferNotice = ctx.hasUI && ctx.sessionManager.getEntries().some((entry) => entry.type === "compaction");
		const reason = this.safeInactive(ctx);
		if (reason) {
			this.standAside(ctx, reason, deferNotice);
			return;
		}
		if (this.guard(ctx, () => this.assertReady(ctx))) {
			this.readyStatus(ctx);
			this.sessionNotice(ctx, `ready:${ctx.sessionManager.getSessionId()}`, readyNotice(), deferNotice);
		}
	}

	private sessionNotice(ctx: ExtensionContext, key: string, text: string, defer = false): void {
		if (defer) {
			this.pendingSessionNotice = { sessionId: ctx.sessionManager.getSessionId(), key, text };
		} else if (this.notices.once(key)) {
			notify(ctx, text, "info");
		}
	}

	/** The first input arrives after Pi has rendered the reopened session. */
	showSessionNotice(ctx: ExtensionContext): void {
		const pending = this.pendingSessionNotice;
		this.pendingSessionNotice = undefined;
		if (pending?.sessionId === ctx.sessionManager.getSessionId()) {
			this.sessionNotice(ctx, pending.key, pending.text);
		}
	}

	/** The preview leaves this session to Pi; say so once per session and process. */
	standAside(ctx: ExtensionContext, reason: InactiveReason, deferNotice = false): void {
		setStatusLine(ctx, undefined);
		this.sessionNotice(
			ctx,
			`inactive:${ctx.sessionManager.getSessionId()}:${reason}`,
			inactiveNotice(reason, this.hostVersion),
			deferNotice,
		);
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
				(getInitialSystemMessage(messages) ? 0 : piTokens(ctx.getSystemPrompt()));
			if (estimate > requestLimit(ctx.model)) throw new Error("CONTEXT_INPUT_TOO_LARGE");
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
			// JSON escaping and tool schemas sit outside Pi's estimate, so only a payload beyond the window is stopped here.
			if (piTokens(serialized ?? "") > ctx.model.contextWindow) throw new Error("CONTEXT_PAYLOAD_TOO_LARGE");
		});
	}

	/**
	 * Whether Pi's threshold compaction may run now: a completed turn, no queued input and a session that is
	 * not blocked. Otherwise it is left for a later settled turn and nothing is recorded; a blocked session
	 * still needs an explicit /compact.
	 */
	thresholdReady(ctx: ExtensionContext): boolean {
		try {
			const session = ctx.sessionManager;
			if (this.configError || !this.config || ctx.hasPendingMessages()) return false;
			if (this.stickyFailures.has(session.getSessionId()) || this.store.inspect(session).state !== "ready")
				return false;
			const last = [...session.buildSessionProjection().messages]
				.reverse()
				.find((message) => message.role !== "system");
			return last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
		} catch {
			return false;
		}
	}

	async compact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<PreviewCompaction> {
		const started = performance.now();
		this.forgetVerified();
		this.compactionStartedAt.set(ctx.sessionManager.getSessionId(), started);
		this.preparation?.cancel("compaction");
		this.activeCompactions.add(ctx.sessionManager.getSessionId());
		this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
		setStatusLine(ctx, "writing");
		try {
			if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
			const branch = structuredClone(ctx.sessionManager.getBranch());
			const { checkpoint: previous, sourceHash: branchHash } = assertHashedPreviewSession(
				ctx.sessionManager,
				this.hostVersion,
				branch,
			);
			// Pi's threshold compaction runs after a completed turn, exactly where /compact may run.
			if (!(event.reason === "manual" || event.reason === "threshold") || event.willRetry) {
				throw new Error("CONTEXT_PREVIEW_COMPACT_REQUIRED: overflow recovery needs an explicit /compact");
			}
			event.signal.throwIfAborted();
			const projection = ctx.sessionManager.buildSessionProjection();
			assertToolPairs(projection.messages);
			const last = [...projection.messages].reverse().find((message) => message.role !== "system");
			const completed = last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
			const readback: PreviewReadback = {};
			const recovering =
				this.stickyFailures.has(ctx.sessionManager.getSessionId()) ||
				this.store.status(ctx.sessionManager, branchHash, readback).state !== "ready";
			const terminated =
				last?.role === "user" ||
				(last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted"));
			if (!last || !(completed || (recovering && terminated)) || ctx.hasPendingMessages()) {
				throw new Error("CONTEXT_TOOL_BOUNDARY: manual compaction requires a completed turn with no queued input");
			}
			if (!ctx.model || !ctx.sessionManager.getLeafId()) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
			// Only an explicit manual retry replaces blocked/pending with a new durable pending attempt.
			const attempt = this.store.begin(ctx.sessionManager, event.reason === "manual", branchHash, readback);
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
			const retainedFrom = (start: number) => {
				const ids = new Set(branch.slice(start).map((entry) => entry.id));
				return projection.entries
					.filter((entry) => entry.sourceEntry.type !== "compaction" && ids.has(entry.sourceEntry.id))
					.flatMap((entry) => entry.messages);
			};
			let kept = retainedFrom(cut);
			assertToolPairs(kept);
			let firstKeptEntryId = cut < branch.length ? branch[cut].id : CONTEXT_KEEP_NONE;
			let coveredIndex = branch.length - 1;
			// Notes kept after an earlier prefix checkpoint are still candidates for the next one.
			const notes = workNotes(branch, previous?.memory.coveredThrough);
			const increments = notes.map((item) => item.note);
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
			this.lastProgress.delete(attempt.sessionId);
			const submission = this.preparation?.enabled
				? { ...this.preparationSubmission(ctx, event.customInstructions), noteBudget: policy }
				: undefined;
			const available = submission ? this.preparation?.take(submission) : undefined;
			let path: "complete" | "prefix" | "notes" | "sync" =
				available?.classification.status === "current-full" ? "complete" : "sync";
			const systemTokens = textTokens(ctx.getSystemPrompt());
			const beforeTokens =
				systemTokens + projection.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
			let userMessages: SessionEntry[] = [];
			/**
			 * D16: commit `note` for the prefix through `end` and keep every later original verbatim. Only when the cut
			 * releases nothing uncovered, the context shrinks and the result fits within `share` of the threshold.
			 * Returns why it did not commit.
			 */
			const commitPrefix = (
				note: MemoryNote,
				end: number,
				share: number,
				users: SessionEntry[] = [],
			): NotesFallback | undefined => {
				const start = prefixCut(branch, projection, end, cut);
				if (start === undefined) return "cut";
				const retained = retainedFrom(start);
				const retainedTokens = systemTokens + retained.reduce((sum, message) => sum + estimateTokens(message), 0);
				const section = users.length ? renderUserMessages(users) : "";
				// Every message in full or none: beyond this bound the writer consolidates the user's messages instead.
				if (textTokens(section) > Math.min(6000, Math.floor(budget.threshold * 0.05))) return "user-messages";
				const summary = fittedSummary(note, branch, retainedTokens, Math.floor(budget.threshold * share), section);
				if (!summary || textTokens(summary) + retainedTokens >= beforeTokens) return "fit";
				assertToolPairs(retained);
				kept = retained;
				firstKeptEntryId = branch[start].id;
				coveredIndex = end;
				userMessages = users;
				return undefined;
			};
			if (path === "sync" && available && interrupted === undefined) {
				const end = reusablePrefix(available.candidate, available.classification, branch);
				if (end !== undefined && !commitPrefix(available.written.note, end, 0.8)) path = "prefix";
			}
			// D18: merge the session model's work notes without a writer call; the user's own messages follow verbatim.
			// When B leaves a compaction to the writer, the reason is recorded for evaluation.
			let notesNote: MemoryNote | undefined;
			let notesFallback: NotesFallback | undefined;
			if (path === "sync" && this.workNotes.enabled) {
				if (!notes.length) notesFallback = "no-notes";
				else if (interrupted !== undefined) notesFallback = "unfinished-turn";
				else if (event.customInstructions?.trim()) notesFallback = "custom-focus";
				else {
					const end = notes[notes.length - 1].index;
					const merged = mergeWorkNotes(previous?.memory.note, notes);
					try {
						notesNote = merged && validateNote(merged, branch.slice(0, end + 1), policy.hardTokens);
					} catch {
						notesNote = undefined;
					}
					const users = coveredUserMessages(branch, activeIds, end, carriedUserMessages(previous?.entry));
					// The turn of the last note stays verbatim; if that leaves half the threshold or more, a writer call is
					// worth more than a commit that barely compacts.
					notesFallback = notesNote ? commitPrefix(notesNote, end, 0.5, users) : "merge";
					if (!notesFallback) path = "notes";
				}
			}
			// A candidate that is not committed as it stands is discarded; its calls remain in the journal.
			const reused = path === "complete" || path === "prefix" ? available : undefined;
			const ready = reused
				? {
						...reused.written,
						note: validateNote(
							structuredClone(reused.written.note),
							branch.slice(0, coveredIndex + 1),
							policy.hardTokens,
						),
					}
				: path === "notes" && notesNote
					? { note: notesNote, writerModel: modelName(ctx.model), writerEffort: "off" as const }
					: undefined;
			let written: WriteMemoryResult;
			if (ready) {
				written = { ...ready, usage: sumMemoryUsage([]), chunkCount: 0 };
				this.lastProgress.set(attempt.sessionId, {
					writerModel: written.writerModel,
					writerEffort: written.writerEffort,
					writerCalls: 0,
					usageReports: 0,
					repairUsed: false,
					writerCallDetails: [],
				});
			} else {
				written = await writeMemory({
					config: this.config,
					registry: ctx.modelRegistry,
					sessionModel: ctx.model,
					prefix: sessionWriter ? prefix : undefined,
					sessionThinkingLevel: sessionWriter ? ctx.thinkingLevel : undefined,
					previous: previous?.memory.note,
					increments,
					uncovered: writerSources(branch, previous),
					branch,
					noteTokens: policy.hardTokens,
					baseNoteTokens: policy.baseTokens,
					signal: event.signal,
					customInstructions: event.customInstructions,
					callHooks: this.journal?.hooks(attempt.sessionId, "compaction", attempt.lastCheckpointId ?? "none"),
					onProgress: (progress) => {
						this.lastProgress.set(attempt.sessionId, progress);
					},
				});
			}
			event.signal.throwIfAborted();
			if (
				snapshot.sessionId !== ctx.sessionManager.getSessionId() ||
				snapshot.leafId !== ctx.sessionManager.getLeafId() ||
				attempt.sourceHash !== hashEntries(ctx.sessionManager.getBranch())
			) {
				throw new Error("CONTEXT_SOURCE_CHANGED: discard the generated candidate");
			}
			const summary = fittedSummary(
				written.note,
				branch,
				systemTokens + kept.reduce((sum, message) => sum + estimateTokens(message), 0),
				budget.threshold,
				userMessages.length ? renderUserMessages(userMessages) : "",
			);
			if (!summary) throw new Error("CONTEXT_RECOVERY_TOO_LARGE");
			const candidate: PreviewCompaction = {
				summary,
				firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				usage: written.usage,
				details: {
					kind: CONTEXT_MEMORY_KIND,
					version: CONTEXT_MEMORY_VERSION,
					note: written.note,
					coveredThrough: branch[coveredIndex].id,
					sourceHash:
						coveredIndex === branch.length - 1
							? attempt.sourceHash
							: hashEntries(branch.slice(0, coveredIndex + 1)),
					snapshot,
					writerModel: written.writerModel,
					chunkCount: written.chunkCount,
					build: PREVIEW_BUILD_ID,
					noteBudget: policy,
					...(userMessages.length ? { userMessages: userMessages.map((entry) => entry.id) } : {}),
					...(this.preparation?.enabled || this.workNotes.enabled
						? {
								preparation: {
									version: 1 as const,
									path,
									...(reused
										? {
												candidateId: reused.candidate.input.candidateId,
												callIds: [...reused.candidate.provenance.callIds],
											}
										: {}),
									...(path === "notes" ? { noteIds: notes.map((item) => item.id) } : {}),
									...(notesFallback ? { notesFallback } : {}),
								},
							}
						: {}),
				},
			};
			this.store.stage(ctx.sessionManager, attempt, candidate);
			this.preparation?.staged(reused?.candidate.input.candidateId);
			this.stagedCompactions.add(attempt.sessionId);
			this.lastCompaction.set(attempt.sessionId, {
				path,
				...(reused ? { candidateId: reused.candidate.input.candidateId } : {}),
				foregroundCalls: this.lastProgress.get(attempt.sessionId)?.writerCalls ?? 0,
				stageMs: Math.round(performance.now() - started),
				diskConfirmed: false,
			});
			return candidate;
		} catch (error) {
			const code = previewErrorCode(error, event.signal.aborted);
			this.compactionStartedAt.delete(ctx.sessionManager.getSessionId());
			this.fail(ctx, code);
			throw new Error(code);
		}
	}

	committed(event: SessionCompactEvent, ctx: ExtensionContext): void {
		this.forgetVerified();
		const ours = this.activeCompactions.delete(ctx.sessionManager.getSessionId());
		this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
		// Pi's own compaction of a session this preview does not protect is not a commit of this package.
		if (!ours && !this.protected(ctx)) {
			setStatusLine(ctx, undefined);
			return;
		}
		try {
			const { checkpoint: memory, sourceHash } = assertHashedPreviewSession(ctx.sessionManager, this.hostVersion);
			if (!event.fromExtension || memory?.entry.id !== event.compactionEntry.id) {
				throw new Error("CONTEXT_PREVIEW_COMMIT_UNCONFIRMED");
			}
			// The marker owner reads the exact checkpoint and sources back from persistent JSONL.
			this.store.commit(ctx.sessionManager, event.compactionEntry, sourceHash);
			const started = this.compactionStartedAt.get(ctx.sessionManager.getSessionId());
			this.compactionStartedAt.delete(ctx.sessionManager.getSessionId());
			const last = this.lastCompaction.get(ctx.sessionManager.getSessionId());
			if (last) {
				last.diskConfirmed = true;
				if (started !== undefined) last.pauseMs = Math.round(performance.now() - started);
			}
			this.preparation?.committed();
			this.stickyFailures.delete(ctx.sessionManager.getSessionId());
			this.observedFailures.delete(ctx.sessionManager.getSessionId());
			this.readyStatus(ctx);
			this.notices.confirmed(ctx.sessionManager.getSessionId());
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
		this.forgetVerified();
		try {
			if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
			const { checkpoint: memory, sourceHash } = assertHashedPreviewSession(ctx.sessionManager, this.hostVersion);
			const leaf = ctx.sessionManager.getLeafEntry();
			if (
				leaf?.type !== "compaction" ||
				memory?.entry.id !== leaf.id ||
				!this.store.markerPresent(ctx.sessionManager)
			) {
				throw new Error("CONTEXT_PREVIEW_COMMIT_UNCONFIRMED");
			}
			this.store.recover(ctx.sessionManager, leaf, sourceHash);
			this.preparation?.committed();
			this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
			this.stickyFailures.delete(ctx.sessionManager.getSessionId());
			this.observedFailures.delete(ctx.sessionManager.getSessionId());
			this.readyStatus(ctx);
			this.notices.confirmed(ctx.sessionManager.getSessionId());
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
