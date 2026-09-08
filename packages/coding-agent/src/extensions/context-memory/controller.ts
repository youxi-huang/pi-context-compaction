import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../../core/compaction/compaction.ts";
import { estimateTokens } from "../../core/compaction/index.ts";
import type { ExtensionContext, SessionBeforeCompactEvent } from "../../core/extensions/types.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { ReadonlySessionManager, SessionEntry } from "../../core/session-manager.ts";
import type { CompactionSettings } from "../../core/settings-manager.ts";
import { CONTEXT_MEMORY_BUILD } from "./build.ts";
import { type MemoryConfig, memoryBudget, textTokens } from "./config.ts";
import { CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION } from "./identity.ts";
import {
	hashEntries,
	latestMemory,
	type MemoryCheckpoint,
	noteIncrements,
	renderNote,
	type SourceSnapshot,
} from "./notes.ts";
import { assertReadableBranch } from "./storage.ts";
import { writeMemory } from "./writer.ts";

export interface MemoryHost {
	config: Readonly<MemoryConfig>;
	runtime: ModelRuntime;
	session: ReadonlySessionManager;
	setCompaction(overrides: Partial<CompactionSettings>): void;
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

/** One controller survives extension reloads. No background summarizer or per-turn paid work. */
export class MemoryController {
	private readonly host: MemoryHost;
	private frozen?: SourceSnapshot;
	private failedBoundary?: string;
	private failure?: string;
	private lastModel?: Model<Api>;

	constructor(host: MemoryHost) {
		this.host = host;
	}

	status() {
		const branch = this.host.session.getBranch();
		const checkpoint = latestMemory(branch);
		return {
			build: CONTEXT_MEMORY_BUILD,
			enabled: this.host.config.enabled,
			writerModel: this.host.config.writerModel,
			state: this.frozen ? "preparing" : this.failedBoundary ? "blocked" : "ready",
			failure: this.failure,
			checkpointId: checkpoint?.entry.id,
			noteIncrements: noteIncrements(branch, checkpoint?.entry.id).length,
			budget: this.lastModel ? memoryBudget(this.lastModel) : undefined,
		};
	}

	refresh(model: Model<Api> | undefined = this.lastModel): void {
		if (!this.host.config.enabled || !model) return;
		this.lastModel = model;
		const budget = memoryBudget(model);
		this.host.setCompaction({
			enabled: true,
			reserveTokens: budget.capacity - budget.threshold,
			keepRecentTokens: budget.recentTokens,
		});
	}

	assertReady(): void {
		const branch = this.host.session.getBranch();
		assertReadableBranch(branch);
		if (this.frozen) throw new Error("CONTEXT_BUSY: checkpoint has not yet committed");
		if (this.failedBoundary)
			throw new Error(
				`CONTEXT_BLOCKED: ${this.failure}; use /compact to retry explicitly, or provide new source input`,
			);
	}

	acceptInput(): void {
		// Input runs before Pi's pre-prompt compact check. Appending that same prompt later must not
		// accidentally unlock a failure and trigger a second writer attempt in the same submission.
		if (!this.frozen) {
			this.failedBoundary = undefined;
			this.failure = undefined;
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
		const budget = memoryBudget(ctx.model);
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
		assertToolPairs(result);
		const estimate =
			result.reduce((total, message) => total + estimateTokens(message), 0) + textTokens(ctx.getSystemPrompt());
		if (estimate > budget.threshold)
			throw new Error(
				"CONTEXT_INPUT_TOO_LARGE: request exceeds the input allowance; compact explicitly or split this input",
			);
		return result;
	}

	beforeRequest(payload: unknown): void {
		this.assertReady();
		if (!this.host.config.enabled || !this.lastModel) return;
		// Final payload also contains tool definitions and provider-specific context additions.
		if (textTokens(JSON.stringify(payload)) > memoryBudget(this.lastModel).threshold)
			throw new Error("CONTEXT_PAYLOAD_TOO_LARGE: provider payload exceeds the reserved input allowance");
	}

	fail(message: string): void {
		this.frozen = undefined;
		this.failedBoundary = sourceBoundary(this.host.session.getBranch());
		this.failure = message;
	}

	committed(): void {
		this.frozen = undefined;
		this.failedBoundary = undefined;
		this.failure = undefined;
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
			const cut = branch.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
			if (cut < 1) throw new Error("CONTEXT_NO_CUT: no earlier evidence can be compacted");
			const kept = branch.slice(cut).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
			assertToolPairs(kept);
			const budget = memoryBudget(ctx.model);
			const previous = latestMemory(branch);
			const after = previous ? branch.findIndex((entry) => entry.id === previous.memory.coveredThrough) : -1;
			const written = await writeMemory({
				config: this.host.config,
				runtime: this.host.runtime,
				previous: previous?.memory.note,
				increments: noteIncrements(branch, previous?.entry.id),
				uncovered: branch.slice(after + 1),
				branch,
				noteTokens: budget.noteTokens,
				signal: event.signal,
				customInstructions: event.customInstructions,
			});
			event.signal.throwIfAborted();
			if (
				snapshot.sessionId !== this.host.session.getSessionId() ||
				snapshot.leafId !== this.host.session.getLeafId() ||
				hashEntries(branch) !== hashEntries(this.host.session.getBranch())
			)
				throw new Error("CONTEXT_SOURCE_CHANGED: discard the candidate and retry explicitly");
			const summary = renderNote(written.note);
			if (
				textTokens(summary) +
					textTokens(ctx.getSystemPrompt()) +
					kept.reduce((total, message) => total + estimateTokens(message), 0) >
				budget.threshold
			)
				throw new Error("CONTEXT_RECOVERY_TOO_LARGE: note and complete recent tool rounds cannot fit");
			return {
				summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				usage: written.usage,
				details: {
					kind: CONTEXT_MEMORY_KIND,
					version: CONTEXT_MEMORY_VERSION,
					note: written.note,
					coveredThrough: snapshot.leafId,
					sourceHash: hashEntries(branch),
					snapshot,
					writerModel: this.host.config.writerModel,
					chunkCount: written.chunkCount,
					build: CONTEXT_MEMORY_BUILD,
				},
			};
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}
}
