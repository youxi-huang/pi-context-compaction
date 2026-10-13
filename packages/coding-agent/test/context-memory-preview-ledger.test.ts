import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectNoteBudget } from "../src/extensions/context-memory/config.ts";
import { freezePreparationInput } from "../src/extensions/context-memory/preview/preparation-candidate.ts";
import {
	type PreparationCallInput,
	type PreparationLedgerPolicy,
	type PreparationUsage,
	PreviewPreparationLedger,
} from "../src/extensions/context-memory/preview/preparation-ledger.ts";
import * as ledgerIo from "../src/extensions/context-memory/preview/preparation-ledger-io.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sessionHash = digest("synthetic-session");
const firstInterval = digest("synthetic-base-checkpoint");
const secondInterval = digest("synthetic-second-checkpoint");
const provenanceHash = digest("synthetic-preparation-envelope");
const policy: PreparationLedgerPolicy = {
	maxAttemptsPerInterval: 1,
	maxCallsPerInterval: 3,
	maxCallsPerSession: 6,
	maxReservedTokensPerInterval: 3_000,
	maxReservedTokensPerSession: 6_000,
	maxReservedCostMicrosPerInterval: 300,
	maxReservedCostMicrosPerSession: 600,
	maxDetails: 2,
};

function usage(tokens = 200, costMicros = 20): PreparationUsage {
	return {
		input: tokens - 60,
		output: 20,
		cacheRead: 30,
		cacheWrite: 10,
		totalTokens: tokens,
		reasoning: 5,
		costMicros,
		costSource: "catalog-estimate",
	};
}

function input(overrides: Partial<PreparationCallInput> = {}): PreparationCallInput {
	return {
		callId: randomUUID(),
		attemptId: randomUUID(),
		intervalHash: firstInterval,
		model: { provider: "synthetic", id: "writer-v1" },
		effort: "medium",
		purpose: "preparation",
		provenanceHash,
		reservation: { tokens: 1_000, costMicros: 100 },
		...overrides,
	};
}

describe("preview preparation cost ledger", () => {
	let root: string;
	let agentDir: string;
	let file: string;
	const open = (limits = policy) => new PreviewPreparationLedger({ agentDir, sessionHash, policy: limits });

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-preview-ledger-"));
		agentDir = join(root, "agent");
		file = join(agentDir, "context-memory-preview", "preparation", `${sessionHash}.json`);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it("inspects without creating any accounting directory or commit marker", () => {
		const ledger = open();
		expect(ledger.status()).toMatchObject({
			state: "ready",
			observationComplete: true,
			aggregate: { attempts: 0, calls: 0, unknownUsage: 0 },
		});
		expect(existsSync(agentDir)).toBe(false);
	});

	it("durably reserves before dispatch and counts attempts separately from calls", () => {
		const ledger = open();
		const first = input();
		expect(ledger.reserve(first)).toEqual({ ok: true });
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			aggregate: { attempts: 1, calls: 1, reservedTokens: 1_000, reservedCostMicros: 100, unknownUsage: 1 },
			calls: [{ callId: first.callId, outcome: "running" }],
		});
		expect(ledger.reserve(input({ attemptId: first.attemptId }))).toEqual({ ok: false, reason: "in-flight" });
		expect(ledger.settle(first.callId, { outcome: "succeeded", usage: usage() })).toEqual({ ok: true });
		const repair = input({ attemptId: first.attemptId, purpose: "repair" });
		expect(ledger.reserve(repair)).toEqual({ ok: true });
		expect(ledger.status().aggregate).toMatchObject({
			attempts: 1,
			calls: 2,
			byPurpose: { preparation: 1, repair: 1 },
		});
		expect(existsSync(join(agentDir, "context-memory-preview", "failures"))).toBe(false);
	});

	it("does not add cumulative callbacks or duplicate settlement twice", () => {
		const ledger = open();
		const first = input();
		ledger.reserve(first);
		const firstReport = { callId: first.callId, usage: usage(), elapsedMs: 10 };
		ledger.progress(first.attemptId, { calls: [firstReport] });
		ledger.progress(first.attemptId, { calls: [firstReport] });
		ledger.settle(first.callId, { outcome: "succeeded", usage: usage(), elapsedMs: 10 });
		ledger.settle(first.callId, { outcome: "succeeded", usage: usage(), elapsedMs: 10 });
		const second = input({ attemptId: first.attemptId });
		ledger.reserve(second);
		const secondReport = { callId: second.callId, usage: usage(300, 30), elapsedMs: 20 };
		ledger.progress(first.attemptId, { calls: [firstReport, secondReport] });
		ledger.progress(first.attemptId, { calls: [firstReport, secondReport] });
		ledger.settle(second.callId, { outcome: "succeeded", usage: usage(300, 30), elapsedMs: 20 });
		expect(ledger.status()).toMatchObject({
			observationComplete: true,
			aggregate: {
				calls: 2,
				settled: 2,
				unknownUsage: 0,
				usage: { totalTokens: 500, costMicros: 50 },
				chargedTokens: 2_000,
			},
		});
		expect(open().status().aggregate.usage.totalTokens).toBe(500);
	});

	it("retains interrupted usage as a lower bound until a complete late report arrives", () => {
		const ledger = open();
		const reserved = input();
		ledger.reserve(reserved);
		ledger.settle(reserved.callId, {
			outcome: "cancelled",
			usage: { ...usage(), cacheWrite1h: 4 },
			usageComplete: false,
		});
		expect(ledger.status()).toMatchObject({
			observationComplete: false,
			aggregate: {
				unknownUsage: 1,
				unknownCost: 1,
				chargedTokens: 1000,
				usage: { totalTokens: 200, cacheWrite1h: 4, costMicros: 20 },
			},
		});
		expect(open().status()).toMatchObject({ state: "ready", observationComplete: false });
		ledger.settle(reserved.callId, {
			outcome: "succeeded",
			usage: { ...usage(300, 30), cacheWrite1h: 5 },
			usageComplete: true,
		});
		expect(ledger.status()).toMatchObject({
			observationComplete: true,
			calls: [{ outcome: "cancelled", usageKnown: true }],
			aggregate: { unknownUsage: 0, unknownCost: 0, usage: { totalTokens: 300, cacheWrite1h: 5 } },
		});
		expect(open().status().observationComplete).toBe(true);
	});

	it("preserves cancellation once, accepts late known usage and charges reused artifacts once", () => {
		const ledger = open();
		const call = input();
		const candidateId = digest("synthetic-candidate-output");
		ledger.reserve(call);
		ledger.settle(call.callId, { outcome: "cancelled", elapsedMs: 8 });
		expect(ledger.status()).toMatchObject({
			observationComplete: false,
			aggregate: { unknownUsage: 1, chargedTokens: 1_000 },
		});
		ledger.settle(call.callId, { outcome: "succeeded", usage: usage(), elapsedMs: 9 });
		ledger.link(call.callId, { candidateId, disposition: "reused" });
		ledger.link(call.callId, { candidateId, disposition: "reused" });
		ledger.link(call.callId, { candidateId, disposition: "superseded" });
		expect(ledger.status()).toMatchObject({
			observationComplete: true,
			aggregate: {
				calls: 1,
				settled: 1,
				unknownUsage: 0,
				usage: { totalTokens: 200 },
				reusedCalls: 1,
				supersededCalls: 1,
			},
			details: [{ outcome: "cancelled" }],
		});
	});

	it("reopens orphans read-only as interrupted unknown without restoring reservations", () => {
		const ledger = open();
		const call = input();
		ledger.reserve(call);
		ledger.progress(call.attemptId, { calls: [{ callId: call.callId, usage: usage() }] });
		const before = readFileSync(file, "utf8");
		const reopened = open();
		expect(reopened.status()).toMatchObject({
			observationComplete: false,
			aggregate: {
				calls: 1,
				settled: 1,
				interrupted: 1,
				unknownUsage: 1,
				chargedTokens: 1_000,
				usage: { totalTokens: 200 },
			},
			details: [{ outcome: "interrupted" }],
			remaining: { attempts: 0, calls: 2, tokens: 2_000, costMicros: 200 },
		});
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(reopened.reserve(input())).toEqual({ ok: false, reason: "budget" });
		expect(reopened.reserve(input({ attemptId: call.attemptId }))).toEqual({ ok: true });
		expect(JSON.parse(readFileSync(file, "utf8")).calls[0]).toMatchObject({
			outcome: "interrupted",
			usageKnown: false,
		});
		reopened.settle(call.callId, { outcome: "failed", usage: usage() });
		expect(reopened.status().aggregate.unknownUsage).toBe(1); // The second call is still unresolved.
	});

	it("keeps a live instance's new call running across repeated status inspections", () => {
		const ledger = open();
		const call = input();
		ledger.reserve(call);
		expect(ledger.status().details[0].outcome).toBe("running");
		expect(ledger.status().details[0].outcome).toBe("running");
		expect(ledger.status().aggregate.interrupted).toBe(0);
	});

	it("rotates rich details atomically while retaining deduplication and late unknown usage", () => {
		const ledger = open();
		const first = input();
		ledger.reserve(first);
		ledger.settle(first.callId, { outcome: "cancelled" });
		for (let index = 0; index < 2; index++) {
			const call = input({ attemptId: first.attemptId });
			ledger.reserve(call);
			ledger.settle(call.callId, { outcome: "succeeded", usage: usage() });
		}
		const persisted = JSON.parse(readFileSync(file, "utf8"));
		expect(persisted.details).toHaveLength(2);
		expect(persisted.calls).toHaveLength(3);
		expect(readdirSync(join(agentDir, "context-memory-preview", "preparation"))).toHaveLength(1);
		const reopened = open();
		expect(reopened.reserve(first)).toEqual({ ok: false, reason: "duplicate" });
		expect(reopened.settle(first.callId, { outcome: "failed", usage: usage(300, 30) })).toEqual({ ok: true });
		expect(reopened.status().aggregate).toMatchObject({
			calls: 3,
			unknownUsage: 0,
			usage: { totalTokens: 700, costMicros: 70 },
			byModel: [{ calls: 3 }],
		});
	});

	it("rolls to a new checkpoint interval without resetting session caps or reopening old intervals", () => {
		const small = { ...policy, maxCallsPerInterval: 1, maxCallsPerSession: 2 };
		const ledger = open(small);
		const first = input();
		ledger.reserve(first);
		ledger.settle(first.callId, { outcome: "cancelled" });
		expect(ledger.reserve(input({ attemptId: first.attemptId }))).toEqual({ ok: false, reason: "budget" });
		const second = input({ intervalHash: secondInterval });
		expect(ledger.reserve(second)).toEqual({ ok: true });
		ledger.settle(second.callId, { outcome: "succeeded", usage: usage() });
		const reopened = open(small);
		expect(reopened.reserve(input({ intervalHash: firstInterval }))).toEqual({ ok: false, reason: "interval" });
		expect(reopened.reserve(input({ intervalHash: digest("third-checkpoint") }))).toEqual({
			ok: false,
			reason: "budget",
		});
		expect(reopened.status().aggregate).toMatchObject({ attempts: 2, calls: 2, reservedTokens: 2_000 });
	});

	it("accounts for actual usage above reservations and refuses further token or spending excess", () => {
		const ledger = open();
		const call = input();
		ledger.reserve(call);
		ledger.settle(call.callId, { outcome: "failed", usage: usage(2_100, 250) });
		expect(ledger.status()).toMatchObject({
			remaining: { tokens: 900, costMicros: 50 },
			aggregate: { chargedTokens: 2_100, chargedCostMicros: 250 },
		});
		expect(ledger.reserve(input({ attemptId: call.attemptId }))).toEqual({ ok: false, reason: "budget" });
	});

	it("keeps absent cost unavailable instead of turning it into zero", () => {
		const ledger = open();
		const call = input();
		ledger.reserve(call);
		const reported = { ...usage(), costSource: "unavailable" as const };
		delete reported.costMicros;
		ledger.settle(call.callId, { outcome: "succeeded", usage: reported });
		expect(ledger.status()).toMatchObject({
			observationComplete: false,
			aggregate: { unknownUsage: 0, unknownCost: 1, chargedCostMicros: 100 },
		});
	});

	it("reports mixed known cost provenance and exposes bounded per-call observations", () => {
		const ledger = open();
		const first = input();
		ledger.reserve(first);
		ledger.settle(first.callId, { outcome: "succeeded", usage: usage() });
		const second = input({ attemptId: first.attemptId });
		ledger.reserve(second);
		ledger.settle(second.callId, { outcome: "succeeded", usage: { ...usage(), costSource: "provider-reported" } });
		const status = ledger.status();
		expect(status).toMatchObject({
			observationComplete: true,
			aggregate: { unknownCost: 0, usage: { costMicros: 40, costSource: "mixed" } },
		});
		expect(status.calls.map((call) => call.usage?.costSource)).toEqual(["catalog-estimate", "provider-reported"]);
	});

	it("pauses on decreasing or unreserved cumulative reports without corrupting persisted totals", () => {
		const ledger = open();
		const call = input();
		ledger.reserve(call);
		ledger.progress(call.attemptId, { calls: [{ callId: call.callId, usage: usage(300) }] });
		expect(ledger.progress(call.attemptId, { calls: [{ callId: call.callId, usage: usage(200) }] })).toEqual({
			ok: false,
			reason: "observation-gap",
		});
		expect(ledger.status()).toMatchObject({
			state: "paused",
			observationGap: "report-invalid",
			aggregate: { usage: { totalTokens: 300 } },
		});
		expect(ledger.reserve(input())).toEqual({ ok: false, reason: "observation-gap" });
	});

	it.each(["truncated", "unknown-field", "aggregate-tampered", "incompatible"])(
		"refuses malformed state (%s) without creating a commit block",
		(damage) => {
			const ledger = open();
			ledger.reserve(input());
			const value = JSON.parse(readFileSync(file, "utf8"));
			if (damage === "truncated") writeFileSync(file, "{");
			else {
				if (damage === "unknown-field") value.untrustedContent = "synthetic secret evidence";
				if (damage === "aggregate-tampered") value.aggregate.reservedTokens = 0;
				if (damage === "incompatible") value.schema = 99;
				writeFileSync(file, JSON.stringify(value));
			}
			const reopened = open();
			expect(reopened.status().state).toBe("paused");
			expect(reopened.reserve(input())).toEqual({ ok: false, reason: "observation-gap" });
			expect(JSON.stringify(reopened.status())).not.toContain("synthetic secret evidence");
			expect(existsSync(join(agentDir, "context-memory-preview", "failures"))).toBe(false);
		},
	);

	it("bounds oversized reads and rejects symlink or hardlink state", () => {
		const ledger = open();
		ledger.reserve(input());
		writeFileSync(file, Buffer.alloc(ledgerIo.MAX_PREPARATION_STATE_BYTES + 1));
		expect(open().status()).toMatchObject({ state: "paused", observationGap: "ledger-invalid" });
		rmSync(file);
		const external = join(root, "synthetic-accounting-target");
		writeFileSync(external, "{}\n");
		symlinkSync(external, file);
		expect(open().status().state).toBe("paused");
		rmSync(file);
		linkSync(external, file);
		expect(open().status().state).toBe("paused");
		expect(readFileSync(external, "utf8")).toBe("{}\n");
	});

	it("rejects symlink descendants and bounds the number of session-ledger inodes", () => {
		mkdirSync(agentDir);
		const external = join(root, "external");
		mkdirSync(external);
		symlinkSync(external, join(agentDir, "context-memory-preview"));
		expect(open().reserve(input())).toEqual({ ok: false, reason: "observation-gap" });
		expect(readdirSync(external)).toHaveLength(0);
		rmSync(join(agentDir, "context-memory-preview"));
		const accounting = join(agentDir, "context-memory-preview", "preparation");
		mkdirSync(accounting, { recursive: true });
		for (let index = 0; index < 64; index++)
			writeFileSync(join(accounting, `${digest(`synthetic-other-${index}`)}.json`), "{}\n");
		const ledger = open();
		expect(ledger.reserve(input())).toEqual({ ok: false, reason: "observation-gap" });
		expect(ledger.status().observationGap).toBe("ledger-capacity");
		expect(readdirSync(accounting)).toHaveLength(64);
	});

	it("leaves ordinary commit state alone when publication fails and retains prior reservations", () => {
		const ledger = open();
		const call = input();
		ledger.reserve(call);
		const persisted = readFileSync(file, "utf8");
		vi.spyOn(ledgerIo, "writePreparationState").mockImplementation(() => {
			throw new Error("synthetic provider error with private content");
		});
		expect(ledger.settle(call.callId, { outcome: "failed", usage: usage() })).toEqual({
			ok: false,
			reason: "observation-gap",
		});
		expect(ledger.status()).toMatchObject({ state: "paused", observationGap: "ledger-io" });
		expect(JSON.stringify(ledger.status())).not.toContain("private content");
		expect(readFileSync(file, "utf8")).toBe(persisted);
		expect(existsSync(join(agentDir, "context-memory-preview", "failures"))).toBe(false);
		vi.restoreAllMocks();
		expect(open().status()).toMatchObject({
			aggregate: { calls: 1, interrupted: 1, unknownUsage: 1, chargedTokens: 1_000 },
		});
	});

	it("detects another ledger writer rather than overwriting changed durable accounting", () => {
		const first = open();
		const second = open();
		first.reserve(input());
		expect(second.reserve(input())).toEqual({ ok: false, reason: "observation-gap" });
		expect(second.status().observationGap).toBe("ledger-changed");
		expect(JSON.parse(readFileSync(file, "utf8")).aggregate.calls).toBe(1);
	});

	it("accepts only controlled metadata and exposes snapshots that cannot mutate the ledger", () => {
		const ledger = open();
		expect(
			ledger.reserve(
				input({ callId: "synthetic note content", model: { provider: "synthetic", id: "/private/local/path" } }),
			),
		).toEqual({ ok: false, reason: "invalid" });
		const call = input();
		ledger.reserve(call);
		const status = ledger.status();
		status.aggregate.calls = 0;
		status.details[0].model.id = "modified";
		expect(ledger.status().aggregate.calls).toBe(1);
		const contents = readFileSync(file, "utf8");
		expect(contents).not.toContain(root);
		expect(contents).not.toContain("synthetic note content");
		expect(contents).not.toContain("/private/local/path");
		expect(contents).not.toContain("modified");
	});

	it("rejects a new attempt cheaply without IO while preserving same-attempt writer dispatches", () => {
		const ledger = open();
		const call = input();
		ledger.reserve(call);
		expect(ledger.knownRejection(firstInterval)).toBe("in-flight");
		ledger.settle(call.callId, { outcome: "succeeded", usage: usage() });
		const before = readFileSync(file, "utf8");
		const read = vi.spyOn(ledgerIo, "readPreparationState");
		const write = vi.spyOn(ledgerIo, "writePreparationState");
		expect(ledger.knownRejection(firstInterval)).toBe("budget");
		expect(ledger.knownRejection(secondInterval)).toBeUndefined();
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(readFileSync(file, "utf8")).toBe(before);
		// The negative query is for new attempts, not the writer's reserved next chunk.
		expect(ledger.reserve(input({ attemptId: call.attemptId }))).toEqual({ ok: true });
		expect(read).toHaveBeenCalled();
		expect(write).toHaveBeenCalled();
	});

	it.each(["calls", "tokens", "cost"])(
		"keeps exhausted %s session budgets rejected across new checkpoints and restart",
		(limit) => {
			const limits = {
				...policy,
				maxAttemptsPerInterval: 2,
				...(limit === "calls" ? { maxCallsPerInterval: 2, maxCallsPerSession: 2 } : {}),
			};
			const ledger = open(limits);
			const first = input();
			ledger.reserve(first);
			ledger.settle(first.callId, {
				outcome: "cancelled",
				usage: usage(limit === "tokens" ? 6_000 : 200, limit === "cost" ? 600 : 20),
			});
			if (limit === "calls") {
				const second = input({ attemptId: first.attemptId });
				ledger.reserve(second);
				ledger.settle(second.callId, { outcome: "cancelled", usage: usage() });
			}
			expect(ledger.knownRejection(firstInterval)).toBe("budget");
			expect(ledger.knownRejection(secondInterval)).toBe("budget");
			expect(open(limits).knownRejection(secondInterval)).toBe("budget");
		},
	);

	it("preserves interval budgets after paid cancellation and rejects a return to a retired interval", () => {
		const limits = { ...policy, maxAttemptsPerInterval: 3 };
		const ledger = open(limits);
		const first = input();
		ledger.reserve(first);
		ledger.settle(first.callId, { outcome: "cancelled", usage: usage(3_000) });
		expect(ledger.knownRejection(firstInterval)).toBe("budget");
		expect(ledger.knownRejection(secondInterval)).toBeUndefined();
		const second = input({ intervalHash: secondInterval });
		ledger.reserve(second);
		ledger.settle(second.callId, { outcome: "succeeded", usage: usage() });
		expect(ledger.knownRejection(firstInterval)).toBe("interval");
	});

	it("counts reopen orphans as spent attempts rather than permitting a refund", () => {
		const ledger = open();
		ledger.reserve(input());
		const reopened = open();
		expect(reopened.knownRejection(firstInterval)).toBe("budget");
		expect(reopened.knownRejection(secondInterval)).toBeUndefined();
	});

	it("does not use an absence of known rejection to authorize a dispatch after disk changes", () => {
		const limits = { ...policy, maxAttemptsPerInterval: 2 };
		const ledger = open(limits);
		const first = input();
		ledger.reserve(first);
		ledger.settle(first.callId, { outcome: "succeeded", usage: usage() });
		expect(ledger.knownRejection(firstInterval)).toBeUndefined();
		writeFileSync(file, "{}");
		expect(ledger.knownRejection(firstInterval)).toBeUndefined();
		expect(ledger.reserve(input())).toEqual({ ok: false, reason: "observation-gap" });
		expect(ledger.knownRejection(firstInterval)).toBe("observation-gap");
	});

	it("rejects bounded interval capacity without constructing another aggregate or touching disk", () => {
		const limits = {
			...policy,
			maxCallsPerInterval: 1,
			maxCallsPerSession: 129,
			maxReservedTokensPerSession: 129_000,
			maxReservedCostMicrosPerSession: 12_900,
			maxDetails: 1,
		};
		const ledger = open(limits);
		for (let index = 0; index < 128; index++) {
			const call = input({ intervalHash: digest(`bounded-interval-${index}`) });
			expect(ledger.reserve(call)).toEqual({ ok: true });
			ledger.settle(call.callId, { outcome: "succeeded", usage: usage() });
		}
		const read = vi.spyOn(ledgerIo, "readPreparationState");
		expect(ledger.knownRejection(digest("new-interval-over-capacity"))).toBe("capacity");
		expect(read).not.toHaveBeenCalled();
	});

	it("reopens the same policy independent of object property order", () => {
		const ledger = open();
		const call = input();
		ledger.reserve(call);
		ledger.settle(call.callId, { outcome: "succeeded", usage: usage() });
		const reordered = Object.fromEntries(Object.entries(policy).reverse()) as unknown as PreparationLedgerPolicy;
		expect(open(reordered).status()).toMatchObject({ state: "ready", aggregate: { calls: 1 } });
	});

	it("links real SHA-256 candidate identities durably across reopening", () => {
		const candidate = freezePreparationInput({
			sessionId: "synthetic-session",
			epoch: 0,
			branch: [
				{
					type: "message",
					id: "synthetic-original",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "Synthetic original for a candidate identity.", timestamp: 0 },
				},
			],
			coveredThrough: "synthetic-original",
			processedUserEntryIds: ["synthetic-original"],
			writer: {
				role: "fixed",
				model: "synthetic/writer-v1",
				effort: "medium",
				policyHash: digest("policy"),
				promptHash: digest("prompt"),
				schemaHash: digest("schema"),
				contextHash: null,
			},
			noteBudget: selectNoteBudget({ noteTokens: 3_000 }, 40_000, 100),
		});
		const ledger = open();
		const call = input();
		ledger.reserve(call);
		ledger.settle(call.callId, { outcome: "succeeded", usage: usage() });
		expect(ledger.link(call.callId, { candidateId: candidate.candidateId, disposition: "reused" })).toEqual({
			ok: true,
		});
		const reopened = open();
		expect(reopened.link(call.callId, { candidateId: candidate.candidateId, disposition: "reused" })).toEqual({
			ok: true,
		});
		expect(reopened.status()).toMatchObject({
			state: "ready",
			aggregate: { calls: 1, reusedCalls: 1, usage: { totalTokens: 200 } },
		});
	});

	it("keeps optional reasoning breakdown unavailable while retaining total tokens and cost", () => {
		const ledger = open();
		const call = input();
		ledger.reserve(call);
		const reported = usage();
		delete reported.reasoning;
		expect(ledger.settle(call.callId, { outcome: "succeeded", usage: reported })).toEqual({ ok: true });
		expect(ledger.status()).toMatchObject({
			observationComplete: true,
			aggregate: {
				unknownUsage: 0,
				unknownCost: 0,
				unknownReasoning: 1,
				usage: { totalTokens: 200, costMicros: 20 },
			},
		});
		expect(ledger.status().aggregate.usage.reasoning).toBeUndefined();
		expect(open().status().aggregate.unknownReasoning).toBe(1);
	});

	it("rejects coercible metadata rather than serializing its hidden content", () => {
		const ledger = open();
		const hostileId = {
			privateContent: "synthetic-secret-content",
			toString: () => randomUUID(),
		} as unknown as string;
		expect(ledger.reserve(input({ callId: hostileId }))).toEqual({ ok: false, reason: "invalid" });
		expect(existsSync(file)).toBe(false);
		const call = input();
		ledger.reserve(call);
		const hostileCandidate = {
			privateContent: "synthetic-secret-content",
			toString: () => digest("candidate"),
		} as unknown as string;
		expect(ledger.link(call.callId, { candidateId: hostileCandidate, disposition: "reused" })).toEqual({
			ok: false,
			reason: "invalid",
		});
		const hostileCostSource = {
			privateContent: "synthetic-secret-content",
			toString: () => "catalog-estimate",
		} as unknown as PreparationUsage["costSource"];
		expect(
			ledger.settle(call.callId, { outcome: "failed", usage: { ...usage(), costSource: hostileCostSource } }),
		).toEqual({ ok: false, reason: "observation-gap" });
		expect(readFileSync(file, "utf8")).not.toContain("synthetic-secret-content");
	});

	it("refuses a changed policy instead of silently resetting quota", () => {
		const ledger = open();
		ledger.reserve(input());
		expect(open({ ...policy, maxCallsPerSession: 7 }).status()).toMatchObject({
			state: "paused",
			observationGap: "ledger-incompatible",
		});
	});
});
