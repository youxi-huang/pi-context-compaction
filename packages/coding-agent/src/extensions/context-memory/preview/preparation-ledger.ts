import { createHash } from "node:crypto";
import { isRecord } from "../identity.ts";
import { preparationStateHash, readPreparationState, writePreparationState } from "./preparation-ledger-io.ts";

const MAX_CALLS = 256;
const MAX_INTERVALS = 128;
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const outcomes = ["running", "succeeded", "failed", "cancelled", "interrupted"] as const;
const purposes = ["preparation", "foreground-merge", "synchronous-fallback", "repair"] as const;
const efforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface PreparationLedgerPolicy {
	maxAttemptsPerInterval: number;
	maxCallsPerInterval: number;
	maxCallsPerSession: number;
	maxReservedTokensPerInterval: number;
	maxReservedTokensPerSession: number;
	maxReservedCostMicrosPerInterval: number;
	maxReservedCostMicrosPerSession: number;
	/** Rich details rotate; all bounded call identities and accounting remain. */
	maxDetails: number;
}

export interface PreparationUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** A subset of cacheWrite, retained without adding it to total tokens. */
	cacheWrite1h?: number;
	totalTokens: number;
	/** Optional provider breakdown; never synthesized as zero. */
	reasoning?: number;
	/** Whole-call USD microdollars, never reconstructed from absent usage. */
	costMicros?: number;
	costSource: "provider-reported" | "catalog-estimate" | "unavailable";
}

export interface PreparationReservation {
	tokens: number;
	costMicros: number;
}

export interface PreparationCallInput {
	callId: string;
	attemptId: string;
	/** Deterministic checkpoint/interval identity selected by extension code. */
	intervalHash: string;
	model: { provider: string; id: string };
	effort: (typeof efforts)[number];
	purpose: (typeof purposes)[number];
	/** Hash of the caller-frozen source/config envelope; content is never accepted. */
	provenanceHash: string;
	reservation: PreparationReservation;
}

export interface PreparationCallProgress {
	callId: string;
	usage?: PreparationUsage;
	usageComplete?: boolean;
	elapsedMs?: number;
}

export interface PreparationSettlement {
	outcome: Exclude<(typeof outcomes)[number], "running">;
	usage?: PreparationUsage;
	usageComplete?: boolean;
	elapsedMs?: number;
}

interface CallRecord {
	callId: string;
	attemptId: string;
	intervalHash: string;
	purpose: PreparationCallInput["purpose"];
	reservation: PreparationReservation;
	model: PreparationCallInput["model"];
	effort: PreparationCallInput["effort"];
	outcome: (typeof outcomes)[number];
	usageKnown: boolean;
	usage?: PreparationUsage;
	elapsedMs: number;
	candidateId?: string;
	reused: boolean;
	discarded: boolean;
	superseded: boolean;
}

interface CallDetail {
	callId: string;
	model: PreparationCallInput["model"];
	effort: PreparationCallInput["effort"];
	provenanceHash: string;
}

export interface PreparationAggregate {
	attempts: number;
	calls: number;
	settled: number;
	unknownUsage: number;
	unknownCost: number;
	unknownReasoning: number;
	unknownCacheWrite1h: number;
	interrupted: number;
	reservedTokens: number;
	reservedCostMicros: number;
	/** Reservations are never refunded, including known zero-usage cancellation. */
	chargedTokens: number;
	chargedCostMicros: number;
	usage: Omit<PreparationUsage, "costSource"> & { costSource: PreparationUsage["costSource"] | "mixed" };
	reusedCalls: number;
	discardedCalls: number;
	supersededCalls: number;
	byPurpose: Record<PreparationCallInput["purpose"], number>;
	byModel: Array<{ model: PreparationCallInput["model"]; effort: PreparationCallInput["effort"]; calls: number }>;
}

interface LedgerState {
	schema: 1;
	sessionHash: string;
	policyHash: string;
	intervals: string[];
	calls: CallRecord[];
	details: CallDetail[];
	aggregate: PreparationAggregate;
}

type Gap =
	| "ledger-invalid"
	| "ledger-incompatible"
	| "ledger-changed"
	| "ledger-io"
	| "ledger-capacity"
	| "report-invalid";
export type PreparationLedgerResult =
	| { ok: true }
	| {
			ok: false;
			reason: "observation-gap" | "invalid" | "duplicate" | "in-flight" | "interval" | "budget" | "capacity";
	  };

export type PreparationLedgerRejection = "observation-gap" | "in-flight" | "interval" | "capacity" | "budget";

export interface PreparationLedgerStatus {
	state: "ready" | "paused";
	observationGap?: Gap;
	observationComplete: boolean;
	aggregate: PreparationAggregate;
	activeIntervalHash?: string;
	remaining: { attempts: number; calls: number; tokens: number; costMicros: number };
	/** Bounded accounting records, including archived calls with late-resolvable usage. */
	calls: ReadonlyArray<Readonly<CallRecord>>;
	details: ReadonlyArray<CallDetail & { outcome: CallRecord["outcome"]; usageKnown: boolean }>;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER / 1024): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	return (
		required.every((key) => key in value) &&
		Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
	);
}

function validPolicy(value: PreparationLedgerPolicy): boolean {
	return (
		keys(value as unknown as Record<string, unknown>, [
			"maxAttemptsPerInterval",
			"maxCallsPerInterval",
			"maxCallsPerSession",
			"maxReservedTokensPerInterval",
			"maxReservedTokensPerSession",
			"maxReservedCostMicrosPerInterval",
			"maxReservedCostMicrosPerSession",
			"maxDetails",
		]) &&
		Object.values(value).every((number) => integer(number, 1)) &&
		value.maxCallsPerSession <= MAX_CALLS &&
		value.maxCallsPerInterval <= value.maxCallsPerSession &&
		value.maxAttemptsPerInterval <= value.maxCallsPerInterval &&
		value.maxReservedTokensPerInterval <= value.maxReservedTokensPerSession &&
		value.maxReservedCostMicrosPerInterval <= value.maxReservedCostMicrosPerSession &&
		value.maxDetails <= MAX_CALLS
	);
}

function validUsage(value: unknown): value is PreparationUsage {
	if (
		!isRecord(value) ||
		!keys(
			value,
			["input", "output", "cacheRead", "cacheWrite", "totalTokens", "costSource"],
			["costMicros", "reasoning", "cacheWrite1h"],
		)
	)
		return false;
	if (!["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => integer(value[key]))) return false;
	return (
		(value.reasoning === undefined || integer(value.reasoning)) &&
		(value.cacheWrite1h === undefined ||
			(integer(value.cacheWrite1h) && value.cacheWrite1h <= (value.cacheWrite as number))) &&
		typeof value.costSource === "string" &&
		["provider-reported", "catalog-estimate", "unavailable"].includes(value.costSource) &&
		(value.costSource === "unavailable" ? value.costMicros === undefined : integer(value.costMicros)) &&
		(value.totalTokens as number) >=
			(value.input as number) + (value.output as number) + (value.cacheRead as number) + (value.cacheWrite as number)
	);
}

function validReservation(value: unknown): value is PreparationReservation {
	return (
		isRecord(value) &&
		keys(value, ["tokens", "costMicros"]) &&
		integer(value.tokens, 1) &&
		integer(value.costMicros, 1)
	);
}

function validModel(value: unknown): value is PreparationCallInput["model"] {
	return (
		isRecord(value) &&
		keys(value, ["provider", "id"]) &&
		typeof value.provider === "string" &&
		/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.provider) &&
		typeof value.id === "string" &&
		value.id.length <= 128 &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*){0,2}$/.test(value.id) &&
		!value.id.includes("..")
	);
}

function emptyUsage(): PreparationUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costSource: "unavailable" };
}

function aggregate(calls: readonly CallRecord[]): PreparationAggregate {
	const value: PreparationAggregate = {
		attempts: new Set(calls.map((call) => call.attemptId)).size,
		calls: calls.length,
		settled: 0,
		unknownUsage: 0,
		unknownCost: 0,
		unknownReasoning: 0,
		unknownCacheWrite1h: 0,
		interrupted: 0,
		reservedTokens: 0,
		reservedCostMicros: 0,
		chargedTokens: 0,
		chargedCostMicros: 0,
		usage: emptyUsage(),
		reusedCalls: 0,
		discardedCalls: 0,
		supersededCalls: 0,
		byPurpose: { preparation: 0, "foreground-merge": 0, "synchronous-fallback": 0, repair: 0 },
		byModel: [],
	};
	for (const call of calls) {
		value.settled += Number(call.outcome !== "running");
		value.unknownUsage += Number(!call.usageKnown);
		value.unknownCost += Number(!call.usageKnown || call.usage?.costMicros === undefined);
		value.unknownReasoning += Number(!call.usageKnown || call.usage?.reasoning === undefined);
		value.unknownCacheWrite1h += Number(!call.usageKnown || call.usage?.cacheWrite1h === undefined);
		value.interrupted += Number(call.outcome === "interrupted");
		value.reservedTokens += call.reservation.tokens;
		value.reservedCostMicros += call.reservation.costMicros;
		value.chargedTokens += Math.max(call.reservation.tokens, call.usage?.totalTokens ?? 0);
		value.chargedCostMicros += Math.max(call.reservation.costMicros, call.usage?.costMicros ?? 0);
		value.reusedCalls += Number(call.reused);
		value.discardedCalls += Number(call.discarded);
		value.supersededCalls += Number(call.superseded);
		value.byPurpose[call.purpose]++;
		const model = value.byModel.find(
			(entry) =>
				entry.model.provider === call.model.provider &&
				entry.model.id === call.model.id &&
				entry.effort === call.effort,
		);
		if (model) model.calls++;
		else value.byModel.push({ model: structuredClone(call.model), effort: call.effort, calls: 1 });
		if (call.usage) {
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
				value.usage[key] += call.usage[key];
			if (call.usage.reasoning !== undefined)
				value.usage.reasoning = (value.usage.reasoning ?? 0) + call.usage.reasoning;
			if (call.usage.cacheWrite1h !== undefined)
				value.usage.cacheWrite1h = (value.usage.cacheWrite1h ?? 0) + call.usage.cacheWrite1h;
			if (call.usage.costMicros !== undefined)
				value.usage.costMicros = (value.usage.costMicros ?? 0) + call.usage.costMicros;
		}
	}
	// Incomplete cost stays unavailable; known mixed provenance is distinguished from missing usage.
	if (calls.length && !value.unknownCost) {
		const sources = new Set(calls.map((call) => call.usage?.costSource));
		value.usage.costSource = sources.size === 1 ? calls[0].usage!.costSource : "mixed";
	}
	return value;
}

function validCall(value: unknown): value is CallRecord {
	if (
		!isRecord(value) ||
		!keys(
			value,
			[
				"callId",
				"attemptId",
				"intervalHash",
				"purpose",
				"reservation",
				"model",
				"effort",
				"outcome",
				"usageKnown",
				"elapsedMs",
				"reused",
				"discarded",
				"superseded",
			],
			["usage", "candidateId"],
		)
	)
		return false;
	return (
		typeof value.callId === "string" &&
		idPattern.test(value.callId) &&
		typeof value.attemptId === "string" &&
		idPattern.test(value.attemptId) &&
		typeof value.intervalHash === "string" &&
		hashPattern.test(value.intervalHash) &&
		purposes.includes(value.purpose as PreparationCallInput["purpose"]) &&
		validReservation(value.reservation) &&
		validModel(value.model) &&
		efforts.includes(value.effort as PreparationCallInput["effort"]) &&
		outcomes.includes(value.outcome as CallRecord["outcome"]) &&
		typeof value.usageKnown === "boolean" &&
		(!value.usageKnown || value.usage !== undefined) &&
		(value.usage === undefined || validUsage(value.usage)) &&
		integer(value.elapsedMs) &&
		["reused", "discarded", "superseded"].every((key) => typeof value[key] === "boolean") &&
		(value.candidateId === undefined ||
			(typeof value.candidateId === "string" && hashPattern.test(value.candidateId))) &&
		(!(value.reused || value.superseded) || value.candidateId !== undefined)
	);
}

function validDetail(value: unknown): value is CallDetail {
	return (
		isRecord(value) &&
		keys(value, ["callId", "model", "effort", "provenanceHash"]) &&
		typeof value.callId === "string" &&
		idPattern.test(value.callId) &&
		validModel(value.model) &&
		efforts.includes(value.effort as PreparationCallInput["effort"]) &&
		typeof value.provenanceHash === "string" &&
		hashPattern.test(value.provenanceHash)
	);
}

function parseState(
	bytes: Buffer,
	sessionHash: string,
	policyHash: string,
	policy: PreparationLedgerPolicy,
): LedgerState {
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	if (
		!isRecord(value) ||
		!keys(value, ["schema", "sessionHash", "policyHash", "intervals", "calls", "details", "aggregate"])
	)
		throw new Error("ledger-invalid");
	if (value.schema !== 1 || value.sessionHash !== sessionHash || value.policyHash !== policyHash)
		throw new Error("ledger-incompatible");
	if (
		!Array.isArray(value.intervals) ||
		value.intervals.length > MAX_INTERVALS ||
		!value.intervals.every((hash) => typeof hash === "string" && hashPattern.test(hash)) ||
		new Set(value.intervals).size !== value.intervals.length ||
		!Array.isArray(value.calls) ||
		value.calls.length > policy.maxCallsPerSession ||
		!value.calls.every(validCall) ||
		!Array.isArray(value.details) ||
		value.details.length > policy.maxDetails ||
		!value.details.every(validDetail)
	)
		throw new Error("ledger-invalid");
	const calls = value.calls as CallRecord[];
	const details = value.details as CallDetail[];
	const intervals = value.intervals as string[];
	const ids = new Set(calls.map((call) => call.callId));
	if (
		ids.size !== calls.length ||
		new Set(details.map((detail) => detail.callId)).size !== details.length ||
		details.some((detail) => !ids.has(detail.callId)) ||
		calls.some((call) => !intervals.includes(call.intervalHash)) ||
		calls.some((call) =>
			calls.some((other) => call.attemptId === other.attemptId && call.intervalHash !== other.intervalHash),
		) ||
		calls.filter((call) => call.outcome === "running").length > 1 ||
		JSON.stringify(value.aggregate) !== JSON.stringify(aggregate(calls))
	)
		throw new Error("ledger-invalid");
	return value as unknown as LedgerState;
}

function gap(error: unknown): Gap {
	if (isRecord(error) && error.code === "ledger-invalid") return "ledger-invalid";
	if (error instanceof Error && ["ledger-invalid", "ledger-incompatible", "ledger-capacity"].includes(error.message))
		return error.message as Gap;
	return "ledger-io";
}

/**
 * Optional-preparation accounting, independent of the sticky commit-failure store.
 * One process writes a session. An atomic bounded snapshot publishes aggregates
 * and rotated details together; minimal call records remain for deduplication and
 * late usage. Constructors/status never create directories or session markers.
 */
export class PreviewPreparationLedger {
	private readonly agentDir: string;
	private readonly sessionHash: string;
	private readonly policy: PreparationLedgerPolicy;
	private readonly policyHash: string;
	private state: LedgerState;
	private diskHash: string | undefined;
	private observationGap: Gap | undefined;

	constructor(options: { agentDir: string; sessionHash: string; policy: PreparationLedgerPolicy }) {
		this.agentDir = options.agentDir;
		this.sessionHash = options.sessionHash;
		this.policy = {
			maxAttemptsPerInterval: options.policy.maxAttemptsPerInterval,
			maxCallsPerInterval: options.policy.maxCallsPerInterval,
			maxCallsPerSession: options.policy.maxCallsPerSession,
			maxReservedTokensPerInterval: options.policy.maxReservedTokensPerInterval,
			maxReservedTokensPerSession: options.policy.maxReservedTokensPerSession,
			maxReservedCostMicrosPerInterval: options.policy.maxReservedCostMicrosPerInterval,
			maxReservedCostMicrosPerSession: options.policy.maxReservedCostMicrosPerSession,
			maxDetails: options.policy.maxDetails,
		};
		this.policyHash = createHash("sha256").update(JSON.stringify(this.policy)).digest("hex");
		this.state = {
			schema: 1,
			sessionHash: this.sessionHash,
			policyHash: this.policyHash,
			intervals: [],
			calls: [],
			details: [],
			aggregate: aggregate([]),
		};
		if (typeof this.sessionHash !== "string" || !hashPattern.test(this.sessionHash) || !validPolicy(options.policy)) {
			this.observationGap = "ledger-incompatible";
			return;
		}
		try {
			const bytes = readPreparationState(this.agentDir, this.sessionHash);
			if (!bytes) return;
			this.diskHash = preparationStateHash(bytes);
			this.state = parseState(bytes, this.sessionHash, this.policyHash, this.policy);
			// Read-only orphan classification. The next mutation durably includes it;
			// repeated status/progress on this instance never reclassifies new calls.
			for (const call of this.state.calls) {
				if (call.outcome === "running") {
					call.outcome = "interrupted";
					call.usageKnown = false;
				}
			}
			this.state.aggregate = aggregate(this.state.calls);
		} catch (error) {
			this.observationGap = gap(error);
		}
	}

	private current(): boolean {
		if (this.observationGap) return false;
		try {
			const bytes = readPreparationState(this.agentDir, this.sessionHash);
			if ((bytes ? preparationStateHash(bytes) : undefined) !== this.diskHash) {
				this.observationGap = "ledger-changed";
				return false;
			}
			return true;
		} catch (error) {
			this.observationGap = gap(error);
			return false;
		}
	}

	private publish(next: LedgerState): PreparationLedgerResult {
		next.aggregate = aggregate(next.calls);
		try {
			this.diskHash = preparationStateHash(writePreparationState(this.agentDir, this.sessionHash, next));
			this.state = next;
			return { ok: true };
		} catch (error) {
			this.observationGap = gap(error);
			return { ok: false, reason: "observation-gap" };
		}
	}

	/**
	 * Cheap rejection of a new preparation attempt from owned accounting only. No IO or
	 * state transition: undefined is not authorization, and callers must still use
	 * fresh status/current checks and a durable reservation before dispatch.
	 */
	knownRejection(intervalHash: string): PreparationLedgerRejection | undefined {
		if (this.observationGap) return "observation-gap";
		if (typeof intervalHash !== "string" || !hashPattern.test(intervalHash)) return "interval";
		if (this.state.calls.some((call) => call.outcome === "running")) return "in-flight";
		const active = this.state.intervals.at(-1);
		if (active !== intervalHash && this.state.intervals.includes(intervalHash)) return "interval";
		if (active !== intervalHash && this.state.intervals.length >= MAX_INTERVALS) return "capacity";
		const session = this.state.aggregate;
		if (
			session.calls >= this.policy.maxCallsPerSession ||
			session.chargedTokens >= this.policy.maxReservedTokensPerSession ||
			session.chargedCostMicros >= this.policy.maxReservedCostMicrosPerSession
		)
			return "budget";
		const attempts = new Set<string>();
		let calls = 0;
		let tokens = 0;
		let costMicros = 0;
		for (const call of this.state.calls) {
			if (call.intervalHash !== intervalHash) continue;
			attempts.add(call.attemptId);
			calls++;
			tokens += Math.max(call.reservation.tokens, call.usage?.totalTokens ?? 0);
			costMicros += Math.max(call.reservation.costMicros, call.usage?.costMicros ?? 0);
		}
		if (
			attempts.size >= this.policy.maxAttemptsPerInterval ||
			calls >= this.policy.maxCallsPerInterval ||
			tokens >= this.policy.maxReservedTokensPerInterval ||
			costMicros >= this.policy.maxReservedCostMicrosPerInterval
		)
			return "budget";
		return undefined;
	}

	reserve(input: PreparationCallInput): PreparationLedgerResult {
		if (!this.current()) return { ok: false, reason: "observation-gap" };
		if (
			typeof input.callId !== "string" ||
			!idPattern.test(input.callId) ||
			typeof input.attemptId !== "string" ||
			!idPattern.test(input.attemptId) ||
			typeof input.intervalHash !== "string" ||
			!hashPattern.test(input.intervalHash) ||
			typeof input.provenanceHash !== "string" ||
			!hashPattern.test(input.provenanceHash) ||
			!validModel(input.model) ||
			!efforts.includes(input.effort) ||
			!purposes.includes(input.purpose) ||
			!validReservation(input.reservation)
		)
			return { ok: false, reason: "invalid" };
		if (this.state.calls.some((call) => call.callId === input.callId)) return { ok: false, reason: "duplicate" };
		if (this.state.calls.some((call) => call.outcome === "running")) return { ok: false, reason: "in-flight" };
		const active = this.state.intervals.at(-1);
		if (
			(active !== input.intervalHash && this.state.intervals.includes(input.intervalHash)) ||
			this.state.calls.some((call) => call.attemptId === input.attemptId && call.intervalHash !== input.intervalHash)
		)
			return { ok: false, reason: "interval" };
		if (active !== input.intervalHash && this.state.intervals.length >= MAX_INTERVALS)
			return { ok: false, reason: "capacity" };
		const interval = aggregate(this.state.calls.filter((call) => call.intervalHash === input.intervalHash));
		const session = this.state.aggregate;
		const newAttempt = !this.state.calls.some((call) => call.attemptId === input.attemptId);
		if (
			interval.attempts + Number(newAttempt) > this.policy.maxAttemptsPerInterval ||
			interval.calls + 1 > this.policy.maxCallsPerInterval ||
			session.calls + 1 > this.policy.maxCallsPerSession ||
			interval.chargedTokens + input.reservation.tokens > this.policy.maxReservedTokensPerInterval ||
			session.chargedTokens + input.reservation.tokens > this.policy.maxReservedTokensPerSession ||
			interval.chargedCostMicros + input.reservation.costMicros > this.policy.maxReservedCostMicrosPerInterval ||
			session.chargedCostMicros + input.reservation.costMicros > this.policy.maxReservedCostMicrosPerSession
		)
			return { ok: false, reason: "budget" };
		const next = structuredClone(this.state);
		if (active !== input.intervalHash) next.intervals.push(input.intervalHash);
		next.calls.push({
			callId: input.callId,
			attemptId: input.attemptId,
			intervalHash: input.intervalHash,
			purpose: input.purpose,
			reservation: structuredClone(input.reservation),
			model: structuredClone(input.model),
			effort: input.effort,
			outcome: "running",
			usageKnown: false,
			elapsedMs: 0,
			reused: false,
			discarded: false,
			superseded: false,
		});
		next.details.push({
			callId: input.callId,
			model: structuredClone(input.model),
			effort: input.effort,
			provenanceHash: input.provenanceHash,
		});
		next.details = next.details.slice(-this.policy.maxDetails);
		return this.publish(next);
	}

	private applyReport(call: CallRecord, report: PreparationCallProgress): boolean {
		if (report.usageComplete !== undefined && typeof report.usageComplete !== "boolean") return false;
		if (report.elapsedMs !== undefined && (!integer(report.elapsedMs) || report.elapsedMs < call.elapsedMs))
			return false;
		if (report.usage !== undefined) {
			if (!validUsage(report.usage)) return false;
			if (
				call.usage &&
				(["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const).some(
					(key) => report.usage![key] < call.usage![key],
				)
			)
				return false;
			if (
				call.usage?.costMicros !== undefined &&
				(report.usage.costMicros === undefined || report.usage.costMicros < call.usage.costMicros)
			)
				return false;
			if (
				call.usage?.reasoning !== undefined &&
				report.usage.reasoning !== undefined &&
				report.usage.reasoning < call.usage.reasoning
			)
				return false;
			const previousReasoning = call.usage?.reasoning;
			const previousCacheWrite1h = call.usage?.cacheWrite1h;
			if (
				previousCacheWrite1h !== undefined &&
				report.usage.cacheWrite1h !== undefined &&
				report.usage.cacheWrite1h < previousCacheWrite1h
			)
				return false;
			call.usage = structuredClone(report.usage);
			if (call.usage.reasoning === undefined && previousReasoning !== undefined)
				call.usage.reasoning = previousReasoning;
			if (call.usage.cacheWrite1h === undefined && previousCacheWrite1h !== undefined)
				call.usage.cacheWrite1h = previousCacheWrite1h;
			call.usageKnown = report.usageComplete !== false;
		}
		if (report.elapsedMs !== undefined) call.elapsedMs = report.elapsedMs;
		return true;
	}

	/** Adapter maps cumulative writer call details to their reserved call IDs. */
	progress(attemptId: string, report: { calls: readonly PreparationCallProgress[] }): PreparationLedgerResult {
		if (!this.current()) return { ok: false, reason: "observation-gap" };
		if (
			!idPattern.test(attemptId) ||
			!Array.isArray(report.calls) ||
			report.calls.length > MAX_CALLS ||
			new Set(report.calls.map((call) => call.callId)).size !== report.calls.length
		)
			return { ok: false, reason: "invalid" };
		const next = structuredClone(this.state);
		for (const progress of report.calls) {
			const call = next.calls.find((item) => item.callId === progress.callId && item.attemptId === attemptId);
			if (!call || !this.applyReport(call, progress)) {
				this.observationGap = "report-invalid";
				return { ok: false, reason: "observation-gap" };
			}
		}
		return this.publish(next);
	}

	settle(callId: string, report: PreparationSettlement): PreparationLedgerResult {
		if (!this.current()) return { ok: false, reason: "observation-gap" };
		const next = structuredClone(this.state);
		const call = next.calls.find((item) => item.callId === callId);
		if (!call || !outcomes.includes(report.outcome) || report.outcome === ("running" as string))
			return { ok: false, reason: "invalid" };
		// Late reports resolve missing usage, but cannot rewrite the terminal outcome.
		if (
			!this.applyReport(call, {
				callId,
				usage: report.usage,
				usageComplete: report.usageComplete,
				elapsedMs: report.elapsedMs,
			})
		) {
			this.observationGap = "report-invalid";
			return { ok: false, reason: "observation-gap" };
		}
		if (call.outcome === "running") call.outcome = report.outcome;
		return this.publish(next);
	}

	link(
		callId: string,
		link: { candidateId: string; disposition: "prepared" | "reused" | "discarded" | "superseded" },
	): PreparationLedgerResult {
		if (!this.current()) return { ok: false, reason: "observation-gap" };
		const next = structuredClone(this.state);
		const call = next.calls.find((item) => item.callId === callId);
		if (
			!call ||
			typeof link.candidateId !== "string" ||
			!hashPattern.test(link.candidateId) ||
			!["prepared", "reused", "discarded", "superseded"].includes(link.disposition) ||
			(call.candidateId !== undefined && call.candidateId !== link.candidateId)
		)
			return { ok: false, reason: "invalid" };
		call.candidateId = link.candidateId;
		if (link.disposition !== "prepared") call[link.disposition] = true;
		return this.publish(next);
	}

	/** Retire paid work whose in-memory result was lost; no invented candidate identity. */
	discardUnretained(retainedCallIds: readonly string[]): PreparationLedgerResult {
		if (!this.current()) return { ok: false, reason: "observation-gap" };
		const retained = new Set(retainedCallIds);
		const next = structuredClone(this.state);
		let changed = false;
		for (const call of next.calls) {
			if (call.outcome !== "running" && !call.reused && !call.discarded && !retained.has(call.callId)) {
				call.discarded = true;
				changed = true;
			}
		}
		return changed ? this.publish(next) : { ok: true };
	}

	status(): PreparationLedgerStatus {
		this.current();
		const activeIntervalHash = this.state.intervals.at(-1);
		const interval = aggregate(this.state.calls.filter((call) => call.intervalHash === activeIntervalHash));
		const session = this.state.aggregate;
		return structuredClone({
			state: this.observationGap ? "paused" : "ready",
			...(this.observationGap ? { observationGap: this.observationGap } : {}),
			observationComplete: !this.observationGap && !session.unknownUsage && !session.unknownCost,
			aggregate: session,
			...(activeIntervalHash ? { activeIntervalHash } : {}),
			remaining: {
				attempts: Math.max(0, this.policy.maxAttemptsPerInterval - interval.attempts),
				calls: Math.max(
					0,
					Math.min(
						this.policy.maxCallsPerInterval - interval.calls,
						this.policy.maxCallsPerSession - session.calls,
					),
				),
				tokens: Math.max(
					0,
					Math.min(
						this.policy.maxReservedTokensPerInterval - interval.chargedTokens,
						this.policy.maxReservedTokensPerSession - session.chargedTokens,
					),
				),
				costMicros: Math.max(
					0,
					Math.min(
						this.policy.maxReservedCostMicrosPerInterval - interval.chargedCostMicros,
						this.policy.maxReservedCostMicrosPerSession - session.chargedCostMicros,
					),
				),
			},
			calls: this.state.calls,
			details: this.state.details.map((detail) => {
				const call = this.state.calls.find((item) => item.callId === detail.callId)!;
				return { ...detail, outcome: call.outcome, usageKnown: call.usageKnown };
			}),
		});
	}
}
