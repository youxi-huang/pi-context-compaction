import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../../core/compaction/compaction.ts";
import { estimateTokens } from "../../core/compaction/index.ts";
import type {
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactFailedEvent,
} from "../../core/extensions/types.ts";
import { convertToLlm } from "../../core/messages.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import {
	type ReadonlySessionManager,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "../../core/session-manager.ts";
import type { CompactionSettings } from "../../core/settings-manager.ts";
import { CONTEXT_MEMORY_BUILD } from "./build.ts";
import { type MemoryConfig, memoryBudget, SESSION_WRITER, textTokens } from "./config.ts";
import {
	type CompactionEvent,
	type CompactionOutcome,
	type EventLog,
	errorCode,
	PROJECT_CODES,
	summarizeUsage,
} from "./events.ts";
import { CONTEXT_KEEP_NONE, CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION } from "./identity.ts";
import {
	hashEntries,
	latestMemory,
	type MemoryCheckpoint,
	noteIncrements,
	renderNote,
	type SourceSnapshot,
} from "./notes.ts";
import { assertReadableBranch } from "./storage.ts";
import { modelName, resolveWriterModel, writeMemory } from "./writer.ts";

export interface MemoryHost {
	config: Readonly<MemoryConfig>;
	events: EventLog;
	runtime: ModelRuntime;
	session: ReadonlySessionManager;
	setCompaction(overrides: Partial<CompactionSettings>): void;
}

/** Measurements gathered while one compaction attempt is in flight; settled exactly once. */
interface PendingCompaction {
	startedAt: number;
	reason: CompactionEvent["reason"];
	willRetry: boolean;
	model?: string;
	writerModel?: string;
	errorCode?: string;
	fields: Partial<
		Pick<
			CompactionEvent,
			| "tokensBefore"
			| "tokensAfter"
			| "threshold"
			| "noteTokens"
			| "noteBudget"
			| "sourceEntries"
			| "keptMessages"
			| "increments"
			| "chunkCount"
			| "usage"
			| "writerMs"
		>
	>;
}

function sourceBoundary(branch: readonly SessionEntry[]): string {
	// Error replies and bookkeeping after a failure do not authorize another paid attempt.
	return hashEntries(
		branch.filter(
			(entry) =>
				entry.type === "message" &&
				!(entry.message.role === "assistant" && ["error", "aborted"].includes(entry.message.stopReason)),
		),
	);
}

function assertToolPairs(messages: readonly AgentMessage[]): void {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			if (pending.size) throw new Error("CONTEXT_TOOL_BOUNDARY: missing tool results before a new assistant turn");
			for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
		} else if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId))
				throw new Error("CONTEXT_TOOL_BOUNDARY: tool result has no retained call");
		} else if (pending.size && message.role === "user") {
			throw new Error("CONTEXT_TOOL_BOUNDARY: user input interrupts an unfinished tool batch");
		}
	}
	if (pending.size) throw new Error("CONTEXT_TOOL_BOUNDARY: wait for the current tool batch to finish");
}

/**
 * Choose which original entries stay in model context after the checkpoint. With a zero budget nothing stays once
 * the current turn is complete, so the next request looks like a fresh session that opens with the note; an
 * unfinished or retried turn keeps its own user message and tool rounds. A positive budget keeps whole recent
 * turns up to that estimate; a session smaller than the budget keeps only its latest turn.
 */
export function chooseCut(branch: readonly SessionEntry[], keepRecentTokens: number, willRetry: boolean): number {
	const turnStarts: number[] = [];
	let last: SessionEntry | undefined;
	for (const [index, entry] of branch.entries()) {
		if (entry.type !== "message") continue;
		last = entry;
		if (entry.message.role === "user") turnStarts.push(index);
	}
	if (!last || turnStarts.length === 0) throw new Error("CONTEXT_NO_CUT: no earlier evidence can be compacted");
	const latestTurn = turnStarts[turnStarts.length - 1];
	const finished =
		last.type === "message" && last.message.role === "assistant" && last.message.stopReason !== "toolUse";
	if (keepRecentTokens <= 0) return willRetry || !finished ? latestTurn : branch.length;
	let accumulated = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		accumulated += sessionEntryToContextMessages(branch[i]).reduce(
			(sum, message) => sum + estimateTokens(message),
			0,
		);
		if (accumulated >= keepRecentTokens) return turnStarts.find((start) => start >= i) ?? latestTurn;
	}
	return latestTurn;
}

/** One controller survives extension reloads. No background summarizer or per-turn paid work. */
export class MemoryController {
	private readonly host: MemoryHost;
	private frozen?: SourceSnapshot;
	private failedBoundary?: string;
	private failure?: string;
	private blockReported = false;
	private pending?: PendingCompaction;
	private lastModel?: Model<Api>;
	private activeTools: () => Tool[] = () => [];

	constructor(host: MemoryHost) {
		this.host = host;
	}

	/** Tool definitions of the next provider request; the session writer repeats them to keep the prefix cache warm. */
	bindTools(tools: () => Tool[]): void {
		this.activeTools = tools;
	}

	/** The writer that would run now, or the error class explaining why it cannot. */
	writerStatus(model: Model<Api> | undefined = this.lastModel): { writer?: string; error?: string } {
		try {
			return { writer: modelName(resolveWriterModel(this.host.config, this.host.runtime, model)) };
		} catch (error) {
			return { error: errorCode(error instanceof Error ? error.message : String(error)) };
		}
	}

	status() {
		const branch = this.host.session.getBranch();
		const checkpoint = latestMemory(branch);
		return {
			build: CONTEXT_MEMORY_BUILD,
			enabled: this.host.config.enabled,
			writerModel: this.host.config.writerModel,
			...this.writerStatus(),
			state: this.frozen ? "preparing" : this.failedBoundary ? "blocked" : "ready",
			failure: this.failure,
			checkpointId: checkpoint?.entry.id,
			noteIncrements: noteIncrements(branch, checkpoint?.entry.id).length,
			budget: this.lastModel ? memoryBudget(this.lastModel, this.host.config) : undefined,
			eventLog: this.host.events.file
				? { enabled: true, file: this.host.events.file, lastError: this.host.events.lastError }
				: { enabled: false },
		};
	}

	/** Record a request-side protection, then rethrow. CONTEXT_BLOCKED is reported once per failure. */
	private guarded<T>(operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			const code = errorCode(error instanceof Error ? error.message : String(error));
			if (code !== "CONTEXT_BLOCKED" || !this.blockReported) {
				if (code === "CONTEXT_BLOCKED") this.blockReported = true;
				this.host.events.record({ event: "guard", session: this.host.session.getSessionId(), code });
			}
			throw error;
		}
	}

	private settle(
		outcome: CompactionOutcome,
		code?: string,
		event?: Pick<SessionCompactFailedEvent, "reason" | "willRetry">,
		checkpointId?: string,
	): void {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending && !event) return;
		// Without a pending attempt the resident did no work. Record only a rejection inside the compaction
		// stack (a competing compactor, a storage check); host refusals such as "nothing to compact" and
		// attempts already counted as guard events are not compaction failures.
		if (!pending && (!PROJECT_CODES.has(code ?? "") || code === "CONTEXT_BLOCKED" || code === "CONTEXT_BUSY")) return;
		this.host.events.record({
			event: "compaction",
			session: this.host.session.getSessionId(),
			...pending?.fields,
			reason: pending?.reason ?? event?.reason ?? "manual",
			willRetry: pending?.willRetry ?? event?.willRetry ?? false,
			outcome,
			...(outcome === "committed" ? {} : { errorCode: code ?? "UNKNOWN" }),
			...(pending?.model === undefined ? {} : { model: pending.model }),
			writerModel: pending?.writerModel ?? this.host.config.writerModel,
			...(pending ? { compactMs: Math.round(performance.now() - pending.startedAt) } : {}),
			...(checkpointId === undefined ? {} : { checkpointId }),
		});
	}

	refresh(model: Model<Api> | undefined = this.lastModel): void {
		if (!this.host.config.enabled || !model) return;
		this.lastModel = model;
		const budget = memoryBudget(model, this.host.config);
		this.host.setCompaction({
			enabled: true,
			reserveTokens: budget.capacity - budget.threshold,
			keepRecentTokens: budget.recentTokens,
		});
	}

	assertReady(): void {
		this.guarded(() => {
			const branch = this.host.session.getBranch();
			assertReadableBranch(branch);
			if (this.frozen) throw new Error("CONTEXT_BUSY: checkpoint has not yet committed");
			if (this.failedBoundary)
				throw new Error(
					`CONTEXT_BLOCKED: ${this.failure}; use /compact to retry explicitly, or provide new source input`,
				);
		});
	}

	acceptInput(): void {
		// Input runs before Pi's pre-prompt compact check. Appending that same prompt later must not
		// accidentally unlock a failure and trigger a second writer attempt in the same submission.
		if (!this.frozen) {
			this.failedBoundary = undefined;
			this.failure = undefined;
			this.blockReported = false;
		}
	}

	branchChanged(): void {
		if (this.failedBoundary !== sourceBoundary(this.host.session.getBranch())) this.acceptInput();
	}

	context(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] {
		this.assertReady();
		if (!this.host.config.enabled || !ctx.model) return messages;
		this.refresh(ctx.model);
		const branch = this.host.session.getBranch();
		const checkpoint = latestMemory(branch);
		const increments = noteIncrements(branch, checkpoint?.entry.id);
		const model = ctx.model;
		const budget = this.guarded(() => memoryBudget(model, this.host.config));
		const result = messages.filter(
			(message) => !(message.role === "custom" && message.customType === "context-memory-pending"),
		);
		if (increments.length) {
			const content = `Unverified note candidates since the last checkpoint. Current user messages and original evidence take precedence.\n${increments.map(renderNote).join("\n\n")}`;
			if (textTokens(content) <= budget.noteTokens)
				result.unshift({
					role: "custom",
					customType: "context-memory-pending",
					content,
					display: false,
					timestamp: 0,
				});
			// If candidates overflow, the raw recent messages remain available and the fixed writer will reconcile them.
		}
		this.guarded(() => {
			assertToolPairs(result);
			const estimate =
				result.reduce((total, message) => total + estimateTokens(message), 0) + textTokens(ctx.getSystemPrompt());
			if (estimate > budget.threshold)
				throw new Error(
					"CONTEXT_INPUT_TOO_LARGE: request exceeds the input allowance; compact explicitly or split this input",
				);
		});
		return result;
	}

	beforeRequest(payload: unknown): void {
		this.assertReady();
		if (!this.host.config.enabled || !this.lastModel) return;
		const model = this.lastModel;
		this.guarded(() => {
			// Final payload also contains tool definitions and provider-specific context additions.
			if (textTokens(JSON.stringify(payload)) > memoryBudget(model, this.host.config).threshold)
				throw new Error("CONTEXT_PAYLOAD_TOO_LARGE: provider payload exceeds the reserved input allowance");
		});
	}

	fail(message: string): void {
		this.frozen = undefined;
		this.failedBoundary = sourceBoundary(this.host.session.getBranch());
		this.failure = message;
		this.blockReported = false;
	}

	/** Pi reports every failed or cancelled attempt here, including failures raised after the writer returned. */
	compactionFailed(event: SessionCompactFailedEvent): void {
		const code = this.pending?.errorCode ?? errorCode(event.errorMessage, event.aborted);
		this.fail(event.errorMessage ?? "Compaction cancelled");
		// A request guard rejected a competing attempt; the attempt in flight keeps its own settlement.
		if ((code === "CONTEXT_BUSY" || code === "CONTEXT_BLOCKED") && this.pending?.errorCode === undefined) return;
		this.settle(event.aborted ? "aborted" : "failed", code, event);
	}

	committed(event?: SessionCompactEvent): void {
		this.frozen = undefined;
		this.failedBoundary = undefined;
		this.failure = undefined;
		this.blockReported = false;
		this.settle("committed", undefined, undefined, event?.compactionEntry.id);
	}

	assertCanNote(): void {
		if (this.frozen) throw new Error("CONTEXT_NOTE_FROZEN: wait until compaction finishes");
	}

	async compact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<CompactionResult<MemoryCheckpoint>> {
		if (event.reason === "manual") {
			this.failedBoundary = undefined;
			this.failure = undefined;
		}
		this.assertReady();
		// A previous attempt that Pi never reported back is closed before a new one begins.
		if (this.pending) this.settle("failed", this.pending.errorCode ?? "CONTEXT_UNSETTLED");
		const pending: PendingCompaction = {
			startedAt: performance.now(),
			reason: event.reason,
			willRetry: event.willRetry,
			model: ctx.model?.id,
			fields: { tokensBefore: event.preparation.tokensBefore },
		};
		this.pending = pending;
		const branch = structuredClone(this.host.session.getBranch());
		const snapshot: SourceSnapshot = {
			sessionId: this.host.session.getSessionId(),
			leafId: this.host.session.getLeafId(),
			lastCheckpointId: [...branch].reverse().find((entry) => entry.type === "compaction")?.id ?? null,
		};
		this.frozen = snapshot;
		try {
			if (!ctx.model || !snapshot.leafId) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
			event.signal.throwIfAborted();
			const budget = memoryBudget(ctx.model, this.host.config);
			const cut = chooseCut(branch, budget.recentTokens, event.willRetry);
			if (cut < 1) throw new Error("CONTEXT_NO_CUT: no earlier evidence can be compacted");
			const kept = branch.slice(cut).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
			assertToolPairs(kept);
			const firstKeptEntryId = cut < branch.length ? branch[cut].id : CONTEXT_KEEP_NONE;
			const session = this.host.config.writerModel === SESSION_WRITER;
			pending.writerModel = this.writerStatus(ctx.model).writer;
			const previous = latestMemory(branch);
			const after = previous ? branch.findIndex((entry) => entry.id === previous.memory.coveredThrough) : -1;
			const increments = noteIncrements(branch, previous?.entry.id);
			Object.assign(pending.fields, {
				threshold: budget.threshold,
				noteBudget: budget.noteTokens,
				sourceEntries: branch.slice(after + 1).filter((entry) => entry.type === "message").length,
				keptMessages: kept.length,
				increments: increments.length,
			});
			const writerStarted = performance.now();
			const written = await writeMemory({
				config: this.host.config,
				runtime: this.host.runtime,
				sessionModel: ctx.model,
				prefix: session
					? {
							systemPrompt: ctx.getSystemPrompt(),
							messages: convertToLlm(
								this.host.session
									.buildContextEntries()
									.flatMap(sessionEntryToContextMessages)
									.filter(
										(message) =>
											!(message.role === "custom" && message.customType === "context-memory-pending"),
									),
							),
							tools: this.activeTools(),
						}
					: undefined,
				previous: previous?.memory.note,
				increments,
				uncovered: branch.slice(after + 1),
				branch,
				noteTokens: budget.noteTokens,
				signal: event.signal,
				customInstructions: event.customInstructions,
			});
			pending.writerModel = written.writerModel;
			Object.assign(pending.fields, {
				writerMs: Math.round(performance.now() - writerStarted),
				chunkCount: written.chunkCount,
				usage: summarizeUsage(written.usage),
			});
			event.signal.throwIfAborted();
			if (
				snapshot.sessionId !== this.host.session.getSessionId() ||
				snapshot.leafId !== this.host.session.getLeafId() ||
				hashEntries(branch) !== hashEntries(this.host.session.getBranch())
			)
				throw new Error("CONTEXT_SOURCE_CHANGED: discard the candidate and retry explicitly");
			const summary = renderNote(written.note);
			const tokensAfter =
				textTokens(summary) +
				textTokens(ctx.getSystemPrompt()) +
				kept.reduce((total, message) => total + estimateTokens(message), 0);
			Object.assign(pending.fields, { noteTokens: textTokens(summary), tokensAfter });
			if (tokensAfter > budget.threshold)
				throw new Error("CONTEXT_RECOVERY_TOO_LARGE: note and complete recent tool rounds cannot fit");
			return {
				summary,
				firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				usage: written.usage,
				details: {
					kind: CONTEXT_MEMORY_KIND,
					version: CONTEXT_MEMORY_VERSION,
					note: written.note,
					coveredThrough: snapshot.leafId,
					sourceHash: hashEntries(branch),
					snapshot,
					writerModel: written.writerModel,
					chunkCount: written.chunkCount,
					build: CONTEXT_MEMORY_BUILD,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Pi reports the outcome through session_compact_failed, which settles this attempt once.
			pending.errorCode = errorCode(message, event.signal.aborted);
			this.fail(message);
			throw error;
		}
	}
}
