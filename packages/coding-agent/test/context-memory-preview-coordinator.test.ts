import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_CONFIG, selectNoteBudget } from "../src/extensions/context-memory/config.ts";
import { hashEntries } from "../src/extensions/context-memory/identity.ts";
import type { MemoryNote } from "../src/extensions/context-memory/notes.ts";
import {
	freezePreparationInput,
	type PreparationSnapshot,
	type PreparationSubmission,
} from "../src/extensions/context-memory/preview/preparation-candidate.ts";
import {
	DEFAULT_PREPARATION_CONFIG,
	type PreparationConfigResult,
	parsePreparationConfig,
	readPreparationConfig,
} from "../src/extensions/context-memory/preview/preparation-config.ts";
import {
	type PreparationJob,
	PreviewPreparationCoordinator,
} from "../src/extensions/context-memory/preview/preparation-coordinator.ts";
import * as ledgerIo from "../src/extensions/context-memory/preview/preparation-ledger-io.ts";
import type {
	WriteMemoryResult,
	WriterCallHooks,
	WriterDispatchRequest,
} from "../src/extensions/context-memory/preview/writer.ts";

const sessionId = "synthetic-coordinator-session";
const timestamp = "2026-01-01T00:00:00.000Z";
const source = "Synthetic service uses port 4317.";
const model: Model<"openai-completions"> = {
	api: "openai-completions",
	id: "preparation",
	name: "Synthetic preparation writer",
	provider: "synthetic",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: true,
	contextWindow: 8_000,
	maxTokens: 1_000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};

function user(id: string, parentId: string | null, text = source): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content: text, timestamp: 1 } };
}

function branch(checkpointId?: string): SessionEntry[] {
	const originals = [user("original-1", null)];
	if (!checkpointId) return originals;
	return [
		...originals,
		{
			type: "compaction",
			id: checkpointId,
			parentId: "original-1",
			timestamp,
			summary: "Synthetic prior checkpoint.",
			firstKeptEntryId: "original-1",
			tokensBefore: 100,
		},
		user("original-after-checkpoint", checkpointId, "Synthetic task continues."),
	];
}

function note(): MemoryNote {
	return {
		instructions: [],
		failedPaths: [],
		reasons: [],
		state: [{ text: source, sources: ["original-1"], quote: source }],
		nextSteps: [],
		files: [],
		gaps: [],
	};
}

function usage(): Usage {
	return {
		input: 90,
		output: 20,
		cacheRead: 30,
		cacheWrite: 20,
		cacheWrite1h: 8,
		reasoning: 7,
		totalTokens: 160,
		cost: { input: 0.00009, output: 0.00004, cacheRead: 0.000003, cacheWrite: 0.000025, total: 0.000158 },
	};
}

function written(rawUsage = usage()): WriteMemoryResult {
	return {
		note: note(),
		usage: rawUsage,
		chunkCount: 1,
		writerModel: "synthetic/preparation",
		writerEffort: "medium",
	};
}

function dispatch(callIndex = 1, overrides: Partial<WriterDispatchRequest> = {}): WriterDispatchRequest {
	return {
		callIndex,
		phase: "generate",
		model,
		context: { messages: [] },
		request: { maxTokens: 256 },
		config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "synthetic/preparation" },
		writerEffort: "medium",
		...overrides,
	};
}

function deferred<T>() {
	const callback: { resolve?: (value: T) => void } = {};
	const promise = new Promise<T>((resolve) => {
		callback.resolve = resolve;
	});
	return { promise, resolve: (value: T) => callback.resolve!(value) };
}

async function call(hooks: WriterCallHooks, request = dispatch(), rawUsage: Usage | undefined = usage()) {
	const callId = await hooks.beforeDispatch(request);
	await hooks.afterDispatch({
		callId,
		callIndex: request.callIndex,
		phase: request.phase,
		dispatched: true,
		outcome: "success",
		elapsedMs: 3.25,
		...(rawUsage ? { usage: rawUsage } : {}),
	});
	return callId;
}

function settings(overrides: Record<string, unknown> = {}): PreparationConfigResult {
	const parsed = parsePreparationConfig({ enabled: true, minSourceTokens: 1, minIntervalMs: 0, ...overrides });
	if (parsed.error) throw new Error("Invalid synthetic preparation configuration");
	return parsed;
}

function snapshot(
	coordinator: PreviewPreparationCoordinator,
	entries = branch(),
	selectedSession = sessionId,
): PreparationSnapshot {
	coordinator.activate(selectedSession);
	return freezePreparationInput({
		sessionId: selectedSession,
		epoch: coordinator.currentEpoch,
		branch: entries,
		coveredThrough: entries.at(-1)!.id,
		processedUserEntryIds: entries
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.map((entry) => entry.id),
		writer: {
			role: "fixed",
			model: "synthetic/preparation",
			effort: "medium",
			policyHash: hashEntries(["policy"]),
			promptHash: hashEntries(["prompt"]),
			schemaHash: hashEntries(["schema"]),
			contextHash: null,
		},
		noteBudget: selectNoteBudget({}, 40_000, 100),
	});
}

function submission(input: PreparationSnapshot, entries = [...input.sources]): PreparationSubmission {
	return {
		sessionId: input.sessionId,
		epoch: input.epoch,
		branch: entries,
		writer: input.writer,
		noteBudget: input.noteBudget,
	};
}

function job(input: PreparationSnapshot, result = written()): PreparationJob {
	return {
		input,
		newSourceTokens: 100,
		run: async (_signal, hooks) => {
			await call(hooks);
			return result;
		},
	};
}

describe("preview preparation configuration", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-preparation-config-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("defaults off and freezes opt-in settings without writing any session state", () => {
		expect(parsePreparationConfig(undefined)).toEqual({ config: DEFAULT_PREPARATION_CONFIG });
		expect(readPreparationConfig(join(root, "missing"))).toEqual({ config: DEFAULT_PREPARATION_CONFIG });
		const configured = parsePreparationConfig({ enabled: true, minIntervalMs: 0, ledger: { maxDetails: 2 } });
		expect(configured.error).toBeUndefined();
		expect(configured.config.enabled).toBe(true);
		expect(configured.config.ledger.maxDetails).toBe(2);
		expect(Object.isFrozen(configured.config)).toBe(true);
		expect(Object.isFrozen(configured.config.ledger)).toBe(true);
		expect(existsSync(join(root, "missing"))).toBe(false);
	});

	it.each([
		null,
		[],
		"enabled",
		{ enabled: "true" },
		{ minSourceTokens: 0 },
		{ minIntervalMs: -1 },
		{ deadlineMs: 600_001 },
		{ maxCallsPerAttempt: 9 },
		{ ledger: null },
		{ ledger: { maxCallsPerSession: 257 } },
		{ ledger: { maxCallsPerInterval: 17 } },
		{ ledger: { maxAttemptsPerInterval: 9 } },
		{ ledger: { maxReservedTokensPerInterval: 2_400_001 } },
		{ ledger: { maxReservedCostMicrosPerInterval: 2_000_001 } },
		{ ledger: { maxDetails: 257 } },
		{ rawProviderError: "synthetic private content" },
		{ ledger: { noteContent: "synthetic private content" } },
	])("pauses only optional work on malformed settings: %j", (invalid) => {
		const result = parsePreparationConfig(invalid);
		expect(result).toEqual({ config: DEFAULT_PREPARATION_CONFIG, error: "invalid-config" });
		expect(JSON.stringify(result)).not.toContain("synthetic private content");
	});

	it("latches settings per agent directory and rejects malformed, oversized or linked files", () => {
		const good = join(root, "good");
		mkdirSync(good);
		writeFileSync(join(good, "pi-context-memory.json"), JSON.stringify({ previewPreparation: { enabled: true } }));
		expect(readPreparationConfig(good).config.enabled).toBe(true);
		writeFileSync(join(good, "pi-context-memory.json"), "{");
		expect(readPreparationConfig(good).config.enabled).toBe(true);
		for (const [name, contents] of [
			["malformed", "{"],
			["oversized", " ".repeat(64 * 1024 + 1)],
		]) {
			const dir = join(root, name);
			mkdirSync(dir);
			writeFileSync(join(dir, "pi-context-memory.json"), contents);
			expect(readPreparationConfig(dir)).toEqual({ config: DEFAULT_PREPARATION_CONFIG, error: "invalid-config" });
		}
		const linked = join(root, "linked");
		mkdirSync(linked);
		symlinkSync(join(good, "pi-context-memory.json"), join(linked, "pi-context-memory.json"));
		expect(readPreparationConfig(linked).error).toBe("invalid-config");
		expect(existsSync(join(root, "context-memory-preview"))).toBe(false);
	});
});

describe("preview preparation coordinator", () => {
	let root: string;
	let agentDir: string;
	let coordinators: PreviewPreparationCoordinator[];
	const create = (config = settings(), clock?: () => number) => {
		const coordinator = new PreviewPreparationCoordinator({
			agentDir,
			settings: config,
			...(clock ? { clock } : {}),
		});
		coordinators.push(coordinator);
		return coordinator;
	};
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-preparation-coordinator-"));
		agentDir = join(root, "agent");
		coordinators = [];
	});
	afterEach(async () => {
		for (const coordinator of coordinators) coordinator.dispose();
		for (const coordinator of coordinators) await coordinator.waitForIdle();
		vi.restoreAllMocks();
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	it("uses cheap negative checks without creating or reading an unknown account", async () => {
		const coordinator = create();
		coordinator.activate(sessionId);
		const read = vi.spyOn(ledgerIo, "readPreparationState");
		const write = vi.spyOn(ledgerIo, "writePreparationState");
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(false);
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		const input = snapshot(coordinator);
		coordinator.start(job(input));
		await coordinator.waitForIdle();
		read.mockClear();
		write.mockClear();
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(true);
		expect(coordinator.shouldSkipPreparation(sessionId, "new-checkpoint")).toBe(false);
		expect(coordinator.shouldSkipPreparation("unknown-other-session", null)).toBe(false);
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("uses owned frequency and multiple-attempt budgets without resetting paid work on invalidation", async () => {
		let now = 100;
		const coordinator = create(settings({ minIntervalMs: 50, ledger: { maxAttemptsPerInterval: 2 } }), () => now);
		const input = snapshot(coordinator);
		coordinator.start(job(input));
		await coordinator.waitForIdle();
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(true);
		now += 50;
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(false);
		coordinator.invalidate("model-changed");
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(false);
		expect(coordinator.start(job(snapshot(coordinator)))).toBe(true);
		await coordinator.waitForIdle();
		now += 50;
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(true);
		coordinator.invalidate("new-user-model-change");
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(true);
		expect(coordinator.shouldSkipPreparation(sessionId, "next-checkpoint")).toBe(false);
	});

	it("still checks disk before start when a cheap query has no known rejection", async () => {
		const coordinator = create(settings({ ledger: { maxAttemptsPerInterval: 2 } }));
		const input = snapshot(coordinator);
		coordinator.start(job(input));
		await coordinator.waitForIdle();
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(false);
		const file = join(
			agentDir,
			"context-memory-preview",
			"preparation",
			`${hashEntries(["preparation", sessionId])}.json`,
		);
		writeFileSync(file, "{}");
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(false);
		const run = vi.fn(async () => written());
		expect(coordinator.start({ input, newSourceTokens: 100, run })).toBe(false);
		expect(run).not.toHaveBeenCalled();
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(true);
		expect(coordinator.status().accounting?.state).toBe("paused");
	});

	it("still reserves against fresh disk after start and before provider dispatch", async () => {
		const coordinator = create(settings({ ledger: { maxAttemptsPerInterval: 2 } }));
		const input = snapshot(coordinator);
		coordinator.start(job(input));
		await coordinator.waitForIdle();
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(false);
		let dispatched = 0;
		expect(
			coordinator.start({
				input,
				newSourceTokens: 100,
				run: async (_signal, hooks) => {
					const callId = await hooks.beforeDispatch(dispatch());
					dispatched++;
					await hooks.afterDispatch({
						callId,
						callIndex: 1,
						phase: "generate",
						dispatched: true,
						outcome: "success",
						elapsedMs: 1,
						usage: usage(),
					});
					return written();
				},
			}),
		).toBe(true);
		const file = join(
			agentDir,
			"context-memory-preview",
			"preparation",
			`${hashEntries(["preparation", sessionId])}.json`,
		);
		writeFileSync(file, "{}");
		await coordinator.waitForIdle();
		expect(dispatched).toBe(0);
		expect(coordinator.status().accounting?.state).toBe("paused");
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(true);
	});

	it("loads restart accounting fresh before it can reject an orphaned or exhausted interval cheaply", async () => {
		const previous = create();
		const input = snapshot(previous);
		previous.start(job(input));
		await previous.waitForIdle();
		const reopened = create();
		reopened.activate(sessionId);
		const read = vi.spyOn(ledgerIo, "readPreparationState");
		expect(reopened.shouldSkipPreparation(sessionId, null)).toBe(false);
		expect(read).not.toHaveBeenCalled();
		expect(reopened.start(job(snapshot(reopened)))).toBe(false);
		expect(read).toHaveBeenCalled();
		read.mockClear();
		expect(reopened.shouldSkipPreparation(sessionId, null)).toBe(true);
		expect(reopened.shouldSkipPreparation(sessionId, "next-checkpoint")).toBe(false);
		expect(read).not.toHaveBeenCalled();
	});

	it("keeps default-off and malformed configuration entirely inactive", () => {
		for (const config of [parsePreparationConfig(undefined), parsePreparationConfig({ enabled: "yes" })]) {
			const coordinator = create(config);
			const input = snapshot(coordinator);
			expect(coordinator.start(job(input))).toBe(false);
			expect(coordinator.foregroundHooks(input, "sync")).toBeUndefined();
			expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(true);
			expect(coordinator.status()).toMatchObject({ enabled: false, inFlight: false });
		}
		expect(existsSync(agentDir)).toBe(false);
	});

	it("queues generation after returning, finalizes immutable candidates and preserves actual usage", async () => {
		const coordinator = create();
		const input = snapshot(coordinator);
		const result = written();
		const run = vi.fn(async (_signal: AbortSignal, hooks: WriterCallHooks) => {
			await call(hooks);
			return result;
		});
		expect(coordinator.start({ input, newSourceTokens: 100, run })).toBe(true);
		expect(run).not.toHaveBeenCalled();
		expect(coordinator.status()).toMatchObject({ state: "preparing", inFlight: true });
		await coordinator.waitForIdle();
		const available = coordinator.available(submission(input));
		expect(available?.classification).toEqual({ status: "current-full", reason: "complete" });
		expect(Object.isFrozen(available!.result.candidate.note.state[0])).toBe(true);
		expect(Reflect.set(available!.result.candidate.note.state[0], "text", "changed")).toBe(false);
		result.note.state[0].text = "Changed after writer completion.";
		expect(available!.result.candidate.note.state[0].text).toBe(source);
		expect(available!.result.written.note.state[0].text).toBe(source);
		expect(coordinator.status()).toMatchObject({
			state: "ready",
			accounting: {
				observationComplete: true,
				aggregate: {
					calls: 1,
					reusedCalls: 0,
					usage: {
						input: 90,
						output: 20,
						cacheRead: 30,
						cacheWrite: 20,
						cacheWrite1h: 8,
						reasoning: 7,
						totalTokens: 160,
						costMicros: Math.ceil(usage().cost.total * 1_000_000),
						costSource: "catalog-estimate",
					},
				},
				calls: [{ candidateId: input.candidateId, reused: false }],
			},
		});
		expect(existsSync(join(agentDir, "context-memory-preview", "failures"))).toBe(false);
	});

	it("keeps positive interrupted usage as an incomplete lower bound in preparation accounting", async () => {
		const coordinator = create();
		const input = snapshot(coordinator);
		coordinator.start({
			input,
			newSourceTokens: 100,
			run: async (_signal, hooks) => {
				const callId = await hooks.beforeDispatch(dispatch());
				await hooks.afterDispatch({
					callId,
					callIndex: 1,
					phase: "generate",
					dispatched: true,
					outcome: "failed",
					elapsedMs: 3,
					usage: usage(),
					usageComplete: false,
				});
				throw new Error("Synthetic stream stopped before final usage.");
			},
		});
		await coordinator.waitForIdle();
		expect(coordinator.status()).toMatchObject({
			state: "failed",
			accounting: {
				observationComplete: false,
				aggregate: {
					calls: 1,
					discardedCalls: 1,
					unknownUsage: 1,
					unknownCost: 1,
					usage: { totalTokens: 160, cacheWrite1h: 8 },
				},
			},
		});
	});

	it("preserves unavailable provider breakdowns without inventing zero reasoning or one-hour cache writes", async () => {
		const coordinator = create();
		const input = snapshot(coordinator);
		const raw = usage();
		delete raw.reasoning;
		delete raw.cacheWrite1h;
		coordinator.start({
			input,
			newSourceTokens: 100,
			run: async (_signal, hooks) => {
				await call(hooks, dispatch(), raw);
				return written(raw);
			},
		});
		await coordinator.waitForIdle();
		const status = coordinator.status();
		expect(status).toMatchObject({
			accounting: {
				observationComplete: true,
				aggregate: { unknownReasoning: 1, unknownCacheWrite1h: 1, usage: { totalTokens: 160 } },
			},
		});
		expect(status.accounting?.aggregate.usage.reasoning).toBeUndefined();
		expect(status.accounting?.aggregate.usage.cacheWrite1h).toBeUndefined();
	});

	it("supersedes a successful prior preparation exactly once even when the input snapshot identity is unchanged", async () => {
		const coordinator = create(settings({ ledger: { maxAttemptsPerInterval: 2 } }));
		const input = snapshot(coordinator);
		expect(coordinator.start(job(input))).toBe(true);
		await coordinator.waitForIdle();
		const first = coordinator.available(submission(input))!.result.candidate;
		expect(coordinator.start(job(input))).toBe(true);
		await coordinator.waitForIdle();
		const second = coordinator.available(submission(input))!.result.candidate;
		expect(second.input.candidateId).toBe(first.input.candidateId);
		expect(second.provenance.callIds).not.toEqual(first.provenance.callIds);
		expect(second.outputHash).not.toBe(first.outputHash);
		const status = coordinator.status();
		expect(status).toMatchObject({
			accounting: {
				aggregate: {
					attempts: 2,
					calls: 2,
					supersededCalls: 1,
					discardedCalls: 0,
					reusedCalls: 0,
					usage: { totalTokens: 320 },
				},
			},
		});
		expect(status.accounting?.calls.find((call) => call.callId === first.provenance.callIds[0])?.superseded).toBe(
			true,
		);
		expect(status.accounting?.calls.find((call) => call.callId === second.provenance.callIds[0])?.superseded).toBe(
			false,
		);
		coordinator.available(submission(input));
		expect(coordinator.status().accounting?.aggregate.supersededCalls).toBe(1);
	});

	it("retains the prior candidate when replacement fails and discards only the new paid call", async () => {
		const coordinator = create(settings({ ledger: { maxAttemptsPerInterval: 2 } }));
		const input = snapshot(coordinator);
		coordinator.start(job(input));
		await coordinator.waitForIdle();
		const prior = coordinator.available(submission(input))!.result.candidate;
		coordinator.start({
			input,
			newSourceTokens: 100,
			run: async (_signal, hooks) => {
				await call(hooks);
				throw new Error("Synthetic second preparation failed.");
			},
		});
		await coordinator.waitForIdle();
		const retained = coordinator.available(submission(input))!.result.candidate;
		expect(retained).toBe(prior);
		expect(retained.provenance.callIds).toEqual(prior.provenance.callIds);
		const status = coordinator.status();
		expect(status).toMatchObject({
			accounting: {
				aggregate: { attempts: 2, calls: 2, supersededCalls: 0, discardedCalls: 1, usage: { totalTokens: 320 } },
			},
		});
		expect(status.accounting?.calls.find((call) => call.callId === prior.provenance.callIds[0])).toMatchObject({
			discarded: false,
			superseded: false,
		});
		expect(status.accounting?.calls.find((call) => call.callId !== prior.provenance.callIds[0])).toMatchObject({
			discarded: true,
			superseded: false,
		});
	});

	it("keeps a completed source-valid prefix stale and reusable after a new user ruling", async () => {
		const coordinator = create();
		const input = snapshot(coordinator);
		coordinator.start(job(input));
		await coordinator.waitForIdle();
		const newer = [...branch(), user("new-ruling", "original-1", "Synthetic service now uses port 4318.")];
		const current = submission(input, newer);
		const available = coordinator.available(current);
		expect(available?.classification).toEqual({ status: "stale-reusable", reason: "new-user-input" });
		expect(coordinator.status(current)).toMatchObject({
			state: "stale",
			accounting: { aggregate: { calls: 1, discardedCalls: 0, reusedCalls: 0 } },
		});
		expect(available?.result.candidate.input.coverage.coveredThrough).toBe("original-1");
	});

	it("records prepared linkage before confirmation and records reuse once through the commit-confirmation callback", async () => {
		const coordinator = create();
		const input = snapshot(coordinator);
		coordinator.start(job(input));
		await coordinator.waitForIdle();
		const candidate = coordinator.available(submission(input))!.result.candidate;
		const file = join(
			agentDir,
			"context-memory-preview",
			"preparation",
			`${hashEntries(["preparation", sessionId])}.json`,
		);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			calls: [{ candidateId: input.candidateId, reused: false }],
		});
		// This callback is invoked by the controller after its existing disk-confirmation gate succeeds.
		coordinator.confirmCommitted(sessionId, candidate.input.candidateId, candidate.provenance.callIds);
		coordinator.confirmCommitted(sessionId, candidate.input.candidateId, candidate.provenance.callIds);
		expect(coordinator.status().accounting?.aggregate).toMatchObject({ calls: 1, reusedCalls: 1, discardedCalls: 0 });
		coordinator.checkpointCommitted();
		expect(coordinator.available(submission(input))).toBeUndefined();
		expect(coordinator.status().accounting?.aggregate.reusedCalls).toBe(1);
	});

	it("discards completed in-memory work lost on restart without losing paid usage or interval quota", async () => {
		const previous = create();
		const input = snapshot(previous);
		previous.start(job(input));
		await previous.waitForIdle();
		// A process crash skips dispose; no surviving instance owns the candidate.
		coordinators = coordinators.filter((coordinator) => coordinator !== previous);
		const reopened = create();
		reopened.activate(sessionId);
		reopened.reconcile(sessionId, [], false);
		expect(reopened.status()).toMatchObject({
			accounting: { aggregate: { calls: 1, discardedCalls: 1, reusedCalls: 0, usage: { totalTokens: 160 } } },
		});
		expect(reopened.start(job(snapshot(reopened)))).toBe(false);
		expect(reopened.available(submission(snapshot(reopened)))).toBeUndefined();
	});

	it("retains staged claims across restart and replays reuse only after disk-confirmed recovery", async () => {
		const previous = create();
		const input = snapshot(previous);
		previous.start(job(input));
		await previous.waitForIdle();
		const candidate = previous.available(submission(input))!.result.candidate;
		const claims = [{ candidateId: input.candidateId, callIds: candidate.provenance.callIds }];
		coordinators = coordinators.filter((coordinator) => coordinator !== previous);
		const reopened = create();
		reopened.activate(sessionId);
		reopened.reconcile(sessionId, claims, false);
		expect(reopened.status()).toMatchObject({
			accounting: {
				aggregate: { calls: 1, discardedCalls: 0, reusedCalls: 0 },
				calls: [{ candidateId: input.candidateId, reused: false }],
			},
		});
		// confirmed=true represents successful verification/recovery by the existing commit gate.
		reopened.reconcile(sessionId, claims, true);
		reopened.reconcile(sessionId, claims, true);
		expect(reopened.status()).toMatchObject({
			accounting: { aggregate: { calls: 1, discardedCalls: 0, reusedCalls: 1, usage: { totalTokens: 160 } } },
		});
	});

	it("records paid usage when a result cannot finalize under the frozen actual writer identity", async () => {
		const coordinator = create();
		const input = snapshot(coordinator);
		coordinator.start(job(input, { ...written(), writerModel: "synthetic/unconfigured-writer" }));
		await coordinator.waitForIdle();
		expect(coordinator.available(submission(input))).toBeUndefined();
		expect(coordinator.status()).toMatchObject({
			state: "failed",
			reason: "generation-failed",
			accounting: {
				aggregate: { calls: 1, discardedCalls: 1, usage: { totalTokens: 160 } },
				calls: [{ model: { provider: "synthetic", id: "preparation" } }],
			},
		});
	});

	it("preserves a max reasoning effort supported by the actual writer", async () => {
		const coordinator = create();
		const baseline = snapshot(coordinator);
		const input = freezePreparationInput({
			sessionId,
			epoch: coordinator.currentEpoch,
			branch: branch(),
			coveredThrough: "original-1",
			processedUserEntryIds: ["original-1"],
			writer: { ...baseline.writer, effort: "max" },
			noteBudget: baseline.noteBudget,
		});
		coordinator.start({
			input,
			newSourceTokens: 100,
			run: async (_signal, hooks) => {
				await call(hooks, dispatch(1, { writerEffort: "max" }));
				return { ...written(), writerEffort: "max" };
			},
		});
		await coordinator.waitForIdle();
		expect(coordinator.available(submission(input))?.result.candidate.provenance.writerEffort).toBe("max");
		expect(coordinator.status()).toMatchObject({
			accounting: { calls: [{ effort: "max" }], aggregate: { byModel: [{ effort: "max", calls: 1 }] } },
		});
	});

	it("owns an independent cancellation signal and charges late paid results without publishing them", async () => {
		const coordinator = create();
		const input = snapshot(coordinator);
		const foreground = new AbortController();
		const started = deferred<AbortSignal>();
		const release = deferred<void>();
		coordinator.start({
			input,
			newSourceTokens: 100,
			run: async (signal, hooks) => {
				const callId = await hooks.beforeDispatch(dispatch());
				started.resolve(signal);
				await release.promise;
				await hooks.afterDispatch({
					callId,
					callIndex: 1,
					phase: "generate",
					dispatched: true,
					outcome: signal.aborted ? "cancelled" : "success",
					elapsedMs: 4,
					usage: usage(),
				});
				return written();
			},
		});
		const signal = await started.promise;
		expect(signal).not.toBe(foreground.signal);
		foreground.abort();
		expect(signal.aborted).toBe(false);
		coordinator.cancel();
		expect(signal.aborted).toBe(true);
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(true);
		release.resolve();
		await coordinator.waitForIdle();
		expect(coordinator.available(submission(input))).toBeUndefined();
		expect(coordinator.status()).toMatchObject({
			state: "cancelled",
			accounting: {
				aggregate: { calls: 1, discardedCalls: 1, usage: { totalTokens: 160 } },
				calls: [{ outcome: "cancelled" }],
			},
		});
		expect(existsSync(join(agentDir, "context-memory-preview", "failures"))).toBe(false);
	});

	it("aborts optional generation at its own deadline without losing paid usage", async () => {
		vi.useFakeTimers();
		const coordinator = create(settings({ deadlineMs: 10 }));
		const input = snapshot(coordinator);
		const started = deferred<AbortSignal>();
		coordinator.start({
			input,
			newSourceTokens: 100,
			run: async (signal, hooks) => {
				const callId = await hooks.beforeDispatch(dispatch());
				started.resolve(signal);
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				await hooks.afterDispatch({
					callId,
					callIndex: 1,
					phase: "generate",
					dispatched: true,
					outcome: "cancelled",
					elapsedMs: 10,
					usage: usage(),
				});
				return written();
			},
		});
		const signal = await started.promise;
		await vi.advanceTimersByTimeAsync(11);
		await coordinator.waitForIdle();
		expect(signal.aborted).toBe(true);
		expect(coordinator.status()).toMatchObject({
			state: "cancelled",
			reason: "deadline",
			accounting: { observationComplete: false, aggregate: { discardedCalls: 1, unknownUsage: 1, unknownCost: 1 } },
		});
	});

	it("discards a late result after navigation or teardown rather than publishing into the new epoch", async () => {
		const coordinator = create();
		const input = snapshot(coordinator);
		const started = deferred<void>();
		const release = deferred<void>();
		coordinator.start({
			input,
			newSourceTokens: 100,
			run: async (signal, hooks) => {
				const callId = await hooks.beforeDispatch(dispatch());
				started.resolve();
				await release.promise;
				await hooks.afterDispatch({
					callId,
					callIndex: 1,
					phase: "generate",
					dispatched: true,
					outcome: signal.aborted ? "cancelled" : "success",
					elapsedMs: 2,
					usage: usage(),
				});
				return written();
			},
		});
		await started.promise;
		coordinator.invalidate("tree-navigation");
		release.resolve();
		await coordinator.waitForIdle();
		expect(coordinator.available(submission(input))).toBeUndefined();
		expect(coordinator.status()).toMatchObject({
			accounting: { aggregate: { calls: 1, discardedCalls: 1, usage: { totalTokens: 160 } } },
		});
		coordinator.dispose();
		expect(coordinator.start(job(snapshot(coordinator)))).toBe(false);
	});

	it("pauses optional work immediately on accounting failure while foreground accounting remains advisory", async () => {
		const coordinator = create();
		const input = snapshot(coordinator);
		const run = vi.fn(async (_signal: AbortSignal, hooks: WriterCallHooks) => {
			const callId = await hooks.beforeDispatch(dispatch());
			vi.spyOn(ledgerIo, "writePreparationState").mockImplementation(() => {
				throw new Error("synthetic private accounting failure");
			});
			await hooks.afterDispatch({
				callId,
				callIndex: 1,
				phase: "generate",
				dispatched: true,
				outcome: "success",
				elapsedMs: 3,
				usage: usage(),
			});
			return written();
		});
		coordinator.start({ input, newSourceTokens: 100, run });
		await coordinator.waitForIdle();
		expect(coordinator.status()).toMatchObject({
			state: "paused",
			accountingGap: true,
			accounting: { state: "paused", observationComplete: false },
		});
		expect(coordinator.start(job(input))).toBe(false);
		expect(coordinator.shouldSkipPreparation(sessionId, null)).toBe(true);
		const hooks = coordinator.foregroundHooks(input, "sync")!;
		await expect(call(hooks)).resolves.toEqual(expect.any(String));
		expect(coordinator.status().accountingGap).toBe(true);
		expect(JSON.stringify(coordinator.status())).not.toContain("synthetic private accounting failure");
		expect(existsSync(join(agentDir, "context-memory-preview", "failures"))).toBe(false);
	});

	it("refuses optional dispatch with absent request capacity but lets the foreground writer continue", async () => {
		const coordinator = create();
		const input = snapshot(coordinator);
		coordinator.start({
			input,
			newSourceTokens: 100,
			run: async (_signal, hooks) => {
				await call(hooks, dispatch(1, { request: undefined }));
				return written();
			},
		});
		await coordinator.waitForIdle();
		expect(coordinator.available(submission(input))).toBeUndefined();
		expect(coordinator.status()).toMatchObject({
			state: "failed",
			reason: "price-or-capacity-unavailable",
			accounting: { aggregate: { calls: 0 } },
		});
		await expect(
			call(coordinator.foregroundHooks(input, "sync")!, dispatch(1, { request: undefined })),
		).resolves.toEqual(expect.any(String));
		expect(coordinator.status().accountingGap).toBe(true);
	});

	it("enforces minimum source and interval, attempt and session call caps across restart", async () => {
		let now = 100;
		const config = settings({
			minSourceTokens: 10,
			minIntervalMs: 50,
			maxCallsPerAttempt: 1,
			ledger: { maxCallsPerInterval: 1, maxCallsPerSession: 2 },
		});
		const coordinator = create(config, () => now);
		const first = snapshot(coordinator);
		expect(coordinator.start({ ...job(first), newSourceTokens: 9 })).toBe(false);
		expect(coordinator.start(job(first))).toBe(true);
		await coordinator.waitForIdle();
		coordinator.checkpointCommitted();
		const second = snapshot(coordinator, branch("checkpoint-1"));
		expect(coordinator.start(job(second))).toBe(false);
		now += 50;
		expect(coordinator.start(job(second))).toBe(true);
		await coordinator.waitForIdle();
		coordinator.checkpointCommitted();
		now += 50;
		const third = snapshot(coordinator, branch("checkpoint-2"));
		expect(coordinator.start(job(third))).toBe(false);
		const reopened = create(config, () => now);
		const sameSession = snapshot(reopened, branch("checkpoint-2"));
		expect(reopened.start(job(sameSession))).toBe(false);
		expect(reopened.status()).toMatchObject({
			state: "paused",
			reason: "budget",
			accounting: { aggregate: { attempts: 2, calls: 2 } },
		});
	});

	it("does not automatically reprepare after every new user input in the same checkpoint interval", async () => {
		const coordinator = create();
		const first = snapshot(coordinator);
		coordinator.start(job(first));
		await coordinator.waitForIdle();
		const newer = [...branch(), user("new-user", "original-1", "Synthetic changed ruling.")];
		expect(coordinator.start(job(snapshot(coordinator, newer)))).toBe(false);
		expect(coordinator.status(submission(first, newer))).toMatchObject({
			state: "stale",
			accounting: { aggregate: { attempts: 1, calls: 1 } },
		});
		const reopened = create();
		expect(reopened.start(job(snapshot(reopened, newer)))).toBe(false);
		expect(reopened.status().accounting?.aggregate.calls).toBe(1);
	});

	it("reserves each provider call and counts attempt overflow without erasing earlier paid calls", async () => {
		const coordinator = create(settings({ maxCallsPerAttempt: 2 }));
		const input = snapshot(coordinator);
		coordinator.start({
			input,
			newSourceTokens: 100,
			run: async (_signal, hooks) => {
				for (let index = 1; index <= 3; index++) await call(hooks, dispatch(index));
				return written();
			},
		});
		await coordinator.waitForIdle();
		expect(coordinator.status()).toMatchObject({
			state: "failed",
			reason: "budget-or-accounting",
			accounting: { aggregate: { attempts: 1, calls: 2, usage: { totalTokens: 320 } } },
		});
		expect(coordinator.available(submission(input))).toBeUndefined();
	});

	it("keeps restart-orphan reservations charged and refuses another attempt in the interval", async () => {
		const coordinator = create();
		const input = snapshot(coordinator);
		const started = deferred<void>();
		const release = deferred<void>();
		coordinator.start({
			input,
			newSourceTokens: 100,
			run: async (signal, hooks) => {
				const callId = await hooks.beforeDispatch(dispatch());
				started.resolve();
				await release.promise;
				await hooks.afterDispatch({
					callId,
					callIndex: 1,
					phase: "generate",
					dispatched: true,
					outcome: signal.aborted ? "cancelled" : "success",
					elapsedMs: 2,
				});
				return written();
			},
		});
		await started.promise;
		const reopened = create();
		expect(reopened.start(job(snapshot(reopened)))).toBe(false);
		expect(reopened.status()).toMatchObject({
			accounting: {
				observationComplete: false,
				aggregate: { calls: 1, interrupted: 1, unknownUsage: 1, chargedTokens: 8_256 },
			},
		});
		reopened.reconcile(sessionId, [], false);
		expect(reopened.status().accounting?.calls[0]).toMatchObject({ discarded: true, outcome: "interrupted" });
		expect(reopened.status().accounting?.calls[0].candidateId).toBeUndefined();
		const reopenedAgain = create();
		reopenedAgain.activate(sessionId);
		reopenedAgain.reconcile(sessionId, [], false);
		expect(reopenedAgain.status()).toMatchObject({
			accounting: {
				state: "ready",
				aggregate: { calls: 1, interrupted: 1, unknownUsage: 1, discardedCalls: 1, chargedTokens: 8_256 },
			},
		});
		coordinator.dispose();
		release.resolve();
		await coordinator.waitForIdle();
	});
});
