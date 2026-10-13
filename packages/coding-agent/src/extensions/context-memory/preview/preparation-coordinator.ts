import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import { hashEntries } from "../identity.ts";
import {
	classifyPreparation,
	finalizePreparation,
	type PreparationSnapshot,
	type PreparationSubmission,
	type PreparedCandidate,
} from "./preparation-candidate.ts";
import type { PreparationConfigResult } from "./preparation-config.ts";
import { type PreparationLedgerPolicy, type PreparationUsage, PreviewPreparationLedger } from "./preparation-ledger.ts";
import type { WriteMemoryResult, WriterCallHooks, WriterDispatchRequest, WriterDispatchResult } from "./writer.ts";

export interface PreparationJob {
	input: PreparationSnapshot;
	newSourceTokens: number;
	run(signal: AbortSignal, hooks: WriterCallHooks): Promise<WriteMemoryResult>;
}

interface CompletedPreparation {
	candidate: PreparedCandidate;
	written: WriteMemoryResult;
}

interface RunningPreparation {
	input: PreparationSnapshot;
	abort: AbortController;
	settled: Promise<void>;
}

interface SessionAccounting {
	preparation: PreviewPreparationLedger;
	foreground?: PreviewPreparationLedger;
	gap: boolean;
}

const OBSERVATION_POLICY: PreparationLedgerPolicy = {
	maxAttemptsPerInterval: 128,
	maxCallsPerInterval: 128,
	maxCallsPerSession: 256,
	maxReservedTokensPerInterval: 1_000_000_000_000,
	maxReservedTokensPerSession: 1_000_000_000_000,
	maxReservedCostMicrosPerInterval: 1_000_000_000_000,
	maxReservedCostMicrosPerSession: 1_000_000_000_000,
	maxDetails: 64,
};

/** Pi's cost fields are catalog estimates; they are not provider billing records. */
function observedUsage(usage: Usage): PreparationUsage {
	const cost = usage.cost.total;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
		totalTokens: usage.totalTokens,
		...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
		...(Number.isFinite(cost) && cost >= 0 ? { costMicros: Math.ceil(cost * 1_000_000) } : {}),
		costSource: Number.isFinite(cost) && cost >= 0 ? "catalog-estimate" : "unavailable",
	};
}

function reservation(call: WriterDispatchRequest): { tokens: number; costMicros: number } | undefined {
	const output = call.request?.maxTokens;
	const capacity = call.model.contextWindow;
	const prices = call.model.cost;
	if (
		!Number.isSafeInteger(output) ||
		output === undefined ||
		output < 1 ||
		!Number.isSafeInteger(capacity) ||
		capacity < 1 ||
		![prices.input, prices.output, prices.cacheRead, prices.cacheWrite].every(
			(price) => Number.isFinite(price) && price >= 0,
		)
	)
		return undefined;
	// Reserve against declared capacity, not a claim that our text estimator is a billing bound.
	const tokens = capacity + output;
	const costMicros = Math.max(
		1,
		Math.ceil(capacity * Math.max(prices.input, prices.cacheRead, prices.cacheWrite) + output * prices.output),
	);
	if (![tokens, costMicros].every((value) => Number.isSafeInteger(value) && value <= Number.MAX_SAFE_INTEGER / 1024))
		return undefined;
	return { tokens, costMicros };
}

/** Optional work owns neither a failure marker nor the authoritative checkpoint. */
export class PreviewPreparationCoordinator {
	private readonly agentDir: string;
	private readonly settings: PreparationConfigResult;
	private readonly clock: () => number;
	private readonly accounts = new Map<string, SessionAccounting>();
	private sessionId: string | undefined;
	private running: RunningPreparation | undefined;
	private completed: CompletedPreparation | undefined;
	private epoch = 0;
	private lastStartedAt: number | undefined;
	private disposed = false;
	private state: "idle" | "failed" | "cancelled" | "paused" = "idle";
	private reason: string | undefined;

	constructor(options: { agentDir: string; settings: PreparationConfigResult; clock?: () => number }) {
		this.agentDir = options.agentDir;
		this.settings = options.settings;
		this.clock = options.clock ?? Date.now;
	}

	get enabled(): boolean {
		return this.settings.config.enabled && !this.settings.error;
	}

	get currentEpoch(): number {
		return this.epoch;
	}

	activate(sessionId: string): void {
		if (this.sessionId === sessionId) return;
		this.invalidate("session-changed");
		this.sessionId = sessionId;
		this.lastStartedAt = undefined;
	}

	private accounting(sessionId: string): SessionAccounting {
		const prior = this.accounts.get(sessionId);
		if (prior) return prior;
		if (this.accounts.size >= 32) throw new Error("preparation-capacity");
		const account: SessionAccounting = {
			preparation: new PreviewPreparationLedger({
				agentDir: this.agentDir,
				sessionHash: hashEntries(["preparation", sessionId]),
				policy: this.settings.config.ledger,
			}),
			foreground: new PreviewPreparationLedger({
				agentDir: this.agentDir,
				sessionHash: hashEntries(["foreground", sessionId]),
				policy: OBSERVATION_POLICY,
			}),
			gap: false,
		};
		this.accounts.set(sessionId, account);
		return account;
	}

	private hooks(
		input: PreparationSnapshot,
		purpose: "preparation" | "foreground-merge" | "synchronous-fallback",
		reservedCall?: (id: string) => void,
	): WriterCallHooks {
		const account = this.accounting(input.sessionId);
		const optional = purpose === "preparation";
		if (!optional && !account.foreground) {
			account.foreground = new PreviewPreparationLedger({
				agentDir: this.agentDir,
				sessionHash: hashEntries(["foreground", input.sessionId]),
				policy: OBSERVATION_POLICY,
			});
		}
		const ledger = optional ? account.preparation : account.foreground!;
		const attemptId = randomUUID();
		const recorded = new Set<string>();
		return {
			beforeDispatch: (call) => {
				const callId = randomUUID();
				const reserved = reservation(call);
				const valid =
					reserved !== undefined &&
					(!optional || call.callIndex <= this.settings.config.maxCallsPerAttempt) &&
					ledger.reserve({
						callId,
						attemptId,
						intervalHash: hashEntries([input.sessionId, input.baseCheckpoint?.id ?? null]),
						model: { provider: call.model.provider, id: call.model.id },
						effort: call.writerEffort,
						purpose: call.phase === "repair" ? "repair" : purpose,
						provenanceHash: input.candidateId,
						reservation: reserved,
					}).ok;
				if (valid) {
					recorded.add(callId);
					reservedCall?.(callId);
				} else if (optional) {
					if (ledger.status().state !== "ready") account.gap = true;
					this.reason = reserved ? "budget-or-accounting" : "price-or-capacity-unavailable";
					throw new Error("CONTEXT_PREPARATION_BUDGET");
				} else account.gap = true;
				return callId;
			},
			afterDispatch: (call: WriterDispatchResult) => {
				if (!recorded.has(call.callId)) return;
				const usage = call.usage
					? observedUsage(call.usage)
					: !call.dispatched
						? {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								reasoning: 0,
								costMicros: 0,
								costSource: "catalog-estimate" as const,
							}
						: undefined;
				const result = ledger.settle(call.callId, {
					outcome: call.outcome === "success" ? "succeeded" : call.outcome,
					elapsedMs: Math.round(call.elapsedMs),
					usageComplete: !call.dispatched || (call.usageComplete ?? call.outcome === "success"),
					...(usage ? { usage } : {}),
				});
				if (!result.ok) {
					account.gap = true;
					if (optional) throw new Error("CONTEXT_PREPARATION_ACCOUNTING");
				}
			},
		};
	}

	foregroundHooks(input: PreparationSnapshot, path: "merge" | "sync"): WriterCallHooks | undefined {
		if (!this.enabled) return undefined;
		try {
			return this.hooks(input, path === "merge" ? "foreground-merge" : "synchronous-fallback");
		} catch {
			this.reason = "accounting-unavailable";
			this.state = "paused";
			return undefined;
		}
	}

	/**
	 * Skip expensive snapshot construction only for an already-known rejection.
	 * Unknown accounts and an absence of negative evidence still require the normal
	 * start/status and durable per-call reservation checks; this grants no dispatch.
	 */
	shouldSkipPreparation(sessionId: string, baseCheckpointId: string | null): boolean {
		if (!this.enabled || this.disposed || this.running) return true;
		if (
			this.sessionId === sessionId &&
			this.lastStartedAt !== undefined &&
			this.clock() - this.lastStartedAt < this.settings.config.minIntervalMs
		)
			return true;
		const account = this.accounts.get(sessionId);
		if (!account) return false;
		if (account.gap) return true;
		const intervalHash = hashEntries([sessionId, baseCheckpointId]);
		if (account.foreground?.knownRejection(intervalHash) === "observation-gap") return true;
		return account.preparation.knownRejection(intervalHash) !== undefined;
	}

	start(job: PreparationJob): boolean {
		if (!this.enabled || this.disposed || this.running) return false;
		this.activate(job.input.sessionId);
		if (job.input.epoch !== this.epoch) return false;
		if (job.newSourceTokens < this.settings.config.minSourceTokens) return false;
		if (this.lastStartedAt !== undefined && this.clock() - this.lastStartedAt < this.settings.config.minIntervalMs)
			return false;
		let account: SessionAccounting;
		try {
			account = this.accounting(job.input.sessionId);
			const status = account.preparation.status();
			if (account.gap || status.state !== "ready" || account.foreground?.status().state !== "ready") {
				this.state = "paused";
				this.reason = "accounting-unavailable";
				return false;
			}
			const intervalHash = hashEntries([job.input.sessionId, job.input.baseCheckpoint?.id ?? null]);
			if (status.activeIntervalHash === intervalHash && status.remaining.attempts < 1) return false;
			if (status.aggregate.calls >= this.settings.config.ledger.maxCallsPerSession) {
				this.state = "paused";
				this.reason = "budget";
				return false;
			}
		} catch {
			this.state = "paused";
			this.reason = "accounting-unavailable";
			return false;
		}
		this.lastStartedAt = this.clock();
		this.reason = undefined;
		this.state = "idle";
		const abort = new AbortController();
		const task: RunningPreparation = { input: job.input, abort, settled: Promise.resolve() };
		this.running = task;
		const callIds: string[] = [];
		let published = false;
		const timer = setTimeout(() => {
			this.reason = "deadline";
			this.state = "cancelled";
			abort.abort();
		}, this.settings.config.deadlineMs);
		timer.unref();
		// Queue generation after the host event returns; never await it in the task's turn path.
		task.settled = Promise.resolve()
			.then(() => {
				abort.signal.throwIfAborted();
				return job.run(
					abort.signal,
					this.hooks(job.input, "preparation", (id) => callIds.push(id)),
				);
			})
			.then((written) => {
				if (
					abort.signal.aborted ||
					this.disposed ||
					job.input.epoch !== this.epoch ||
					this.sessionId !== job.input.sessionId
				)
					return;
				const candidate = finalizePreparation(job.input, {
					note: written.note,
					provenance: {
						writerRole: job.input.writer.role,
						writerModel: written.writerModel,
						writerEffort: written.writerEffort,
						callIds,
						reservationIds: callIds,
					},
				});
				for (const id of callIds) {
					if (!account.preparation.link(id, { candidateId: job.input.candidateId, disposition: "prepared" }).ok)
						throw new Error("CONTEXT_PREPARATION_ACCOUNTING");
				}
				this.retireCompleted("superseded");
				this.completed = { candidate, written: structuredClone(written) };
				published = true;
			})
			.catch(() => {
				if (this.sessionId !== job.input.sessionId || job.input.epoch !== this.epoch) return;
				this.state = account.gap ? "paused" : abort.signal.aborted ? "cancelled" : "failed";
				if (account.gap) this.reason = "accounting-unavailable";
				this.reason ??= abort.signal.aborted ? "cancelled" : "generation-failed";
			})
			.finally(() => {
				clearTimeout(timer);
				if (!published) {
					for (const id of callIds) {
						if (
							!account.preparation.link(id, { candidateId: job.input.candidateId, disposition: "discarded" }).ok
						)
							account.gap = true;
					}
				}
				if (this.running === task) this.running = undefined;
				if (account.gap && this.sessionId === job.input.sessionId && job.input.epoch === this.epoch) {
					this.state = "paused";
					this.reason = "accounting-unavailable";
				}
			});
		return true;
	}

	/** Tests and harnesses may wait; task events never do. */
	async waitForIdle(): Promise<void> {
		await this.running?.settled;
	}

	available(
		submission: PreparationSubmission,
	): { result: CompletedPreparation; classification: ReturnType<typeof classifyPreparation> } | undefined {
		if (!this.completed || this.disposed || !this.enabled) return undefined;
		const classification = classifyPreparation(this.completed.candidate, submission);
		if (classification.status === "invalid") {
			this.discard();
			return undefined;
		}
		return { result: this.completed, classification };
	}

	markReused(candidate: PreparedCandidate): void {
		const account = this.accounts.get(candidate.input.sessionId);
		if (!account) return;
		for (const callId of candidate.provenance.callIds) {
			if (!account.preparation.link(callId, { candidateId: candidate.input.candidateId, disposition: "reused" }).ok)
				account.gap = true;
		}
	}

	confirmCommitted(sessionId: string, candidateId: string, callIds: readonly string[]): void {
		try {
			const account = this.accounting(sessionId);
			for (const callId of callIds) {
				if (!account.preparation.link(callId, { candidateId, disposition: "reused" }).ok) account.gap = true;
			}
		} catch {
			this.state = "paused";
			this.reason = "accounting-unavailable";
		}
	}

	/** On restart, protect staged disk claims until explicit recovery confirms them. */
	reconcile(
		sessionId: string,
		claims: ReadonlyArray<{ candidateId: string; callIds: readonly string[] }>,
		confirmed: boolean,
	): void {
		if (!this.enabled) return;
		try {
			const account = this.accounting(sessionId);
			if (confirmed) {
				for (const claim of claims) this.confirmCommitted(sessionId, claim.candidateId, claim.callIds);
			}
			const retained = claims.flatMap((claim) => [...claim.callIds]);
			if (this.completed?.candidate.input.sessionId === sessionId)
				retained.push(...this.completed.candidate.provenance.callIds);
			if (!account.preparation.discardUnretained(retained).ok) account.gap = true;
		} catch {
			this.state = "paused";
			this.reason = "accounting-unavailable";
		}
	}

	checkpointCommitted(): void {
		this.cancel("checkpoint-committed");
		// Successfully used content is retired, not charged as discarded work.
		this.completed = undefined;
		this.epoch++;
		this.state = "idle";
		this.reason = undefined;
	}

	/** A staged disk claim owns the result until commit/recovery, including process shutdown. */
	checkpointStaged(candidateId?: string): void {
		if (candidateId && this.completed?.candidate.input.candidateId === candidateId) this.completed = undefined;
	}

	private discard(): void {
		this.retireCompleted("discarded");
	}

	private retireCompleted(disposition: "discarded" | "superseded"): void {
		const prior = this.completed;
		if (!prior) return;
		const account = this.accounts.get(prior.candidate.input.sessionId);
		for (const callId of prior.candidate.provenance.callIds) {
			if (
				!account?.preparation.link(callId, {
					candidateId: prior.candidate.input.candidateId,
					disposition,
				}).ok
			)
				if (account) account.gap = true;
		}
		this.completed = undefined;
	}

	cancel(reason = "cancelled"): void {
		if (!this.running) return;
		this.state = "cancelled";
		this.reason = reason;
		this.running.abort.abort();
	}

	invalidate(reason: string): void {
		this.cancel(reason);
		this.discard();
		this.epoch++;
		this.state = "idle";
		this.reason = reason;
	}

	dispose(): void {
		this.disposed = true;
		this.invalidate("session-shutdown");
	}

	status(submission?: PreparationSubmission) {
		if (!this.enabled) {
			return {
				enabled: false,
				state: this.settings.error ? "paused" : "disabled",
				reason: this.settings.error,
				inFlight: false,
			};
		}
		let eligibility: ReturnType<typeof classifyPreparation> | undefined;
		if (submission && this.completed) eligibility = classifyPreparation(this.completed.candidate, submission);
		const account = this.sessionId ? this.accounts.get(this.sessionId) : undefined;
		const accounting = account?.preparation.status();
		const foregroundAccounting = account?.foreground?.status();
		const accountingGap = account?.gap || accounting?.state === "paused" || foregroundAccounting?.state === "paused";
		return {
			enabled: true,
			state: accountingGap
				? "paused"
				: this.running
					? "preparing"
					: this.completed && eligibility?.status !== "invalid"
						? eligibility?.status === "stale-reusable"
							? "stale"
							: "ready"
						: this.state,
			reason: accountingGap ? "accounting-unavailable" : (eligibility?.reason ?? this.reason),
			inFlight: this.running !== undefined,
			...(this.completed ? { candidateId: this.completed.candidate.input.candidateId } : {}),
			...(account
				? {
						accounting,
						foregroundAccounting,
						accountingGap: Boolean(accountingGap),
					}
				: {}),
		};
	}
}
