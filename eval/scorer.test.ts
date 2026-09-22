import { describe, expect, it } from "vitest";
import { score, summarize } from "./scorer.ts";
import { scriptedCorrect } from "./scripted-responses.ts";
import { loadFixture } from "./test-utils.ts";

describe("deterministic probe oracles", () => {
	for (const name of ["F1", "F2", "F3"])
		it(`${name}: every oracle accepts a scripted positive and rejects abstention, omission and extra claims`, () => {
			const { fixture, records } = loadFixture(name);
			for (const probe of fixture.probes) {
				const { response, observation } = scriptedCorrect(fixture, probe);
				expect(score(fixture, probe, response, records, observation).pass, probe.id).toBe(true);
				expect(score(fixture, probe, { ...response, status: "abstain" }, records, observation).outcome).toBe(
					"abstained",
				);
				expect(score(fixture, probe, undefined, records, observation).outcome).toBe("omitted");
				expect(score(fixture, probe, response, records, observation, true).outcome).toBe("blocked");
				expect(
					score(
						fixture,
						probe,
						{ ...response, claims: [{ factId: "invented", value: "invented history" }] },
						records,
						observation,
					),
				).toMatchObject({ pass: false, unsupportedClaims: 0, unscoredClaims: 1 });
			}
		});
	it("normalizes numbers only as annotated, enforces units, and separates correctness from support", () => {
		const { fixture, records } = loadFixture("F1");
		const probe = fixture.probes[0];
		const { response } = scriptedCorrect(fixture, probe);
		expect(score(fixture, probe, { ...response, value: " 121 " }, records).pass).toBe(true);
		expect(score(fixture, probe, { ...response, unit: "seconds" }, records).pass).toBe(false);
		expect(score(fixture, probe, { ...response, value: 122 }, records).pass).toBe(false);
		expect(score(fixture, probe, { ...response, allowed: true }, records)).toMatchObject({
			pass: false,
			outcome: "invalid",
			reason: "unexpected-response-fields",
		});
		expect(score(fixture, probe, { ...response, evidence: [{ entryId: records[1].id }] }, records)).toMatchObject({
			pass: true,
			traceable: true,
			supported: false,
		});
	});
	it("accepts quotes and positions fairly, but rejects old, future, unrelated or partial joint evidence", () => {
		const { fixture, records } = loadFixture("F1");
		const joint = fixture.probes.find((p) => p.id.endsWith("-support"))!;
		const { response } = scriptedCorrect(fixture, joint);
		expect(
			score(fixture, joint, { ...response, evidence: response.evidence!.map((e) => ({ quote: e.quote })) }, records)
				.pass,
		).toBe(true);
		expect(
			score(
				fixture,
				joint,
				{
					...response,
					evidence: response.evidence!.map((e) => ({ position: records.findIndex((r) => r.id === e.entryId) })),
				},
				records,
			).pass,
		).toBe(true);
		expect(score(fixture, joint, { ...response, evidence: response.evidence!.slice(0, 1) }, records).pass).toBe(
			false,
		);
		const current = fixture.probes.find((p) => p.id.endsWith("current-support"))!;
		expect(
			score(
				fixture,
				current,
				{
					...scriptedCorrect(fixture, current).response,
					evidence: [{ entryId: records[0].id, quote: "Initial approved port: 4100." }],
				},
				records,
			),
		).toMatchObject({ pass: false, traceable: true, supported: false });
		expect(
			score(
				fixture,
				current,
				{ ...scriptedCorrect(fixture, current).response, evidence: [{ entryId: records.at(-1)!.id }] },
				records,
			).traceable,
		).toBe(false);
		expect(
			score(
				fixture,
				current,
				{
					...scriptedCorrect(fixture, current).response,
					evidence: [{ entryId: records[2].id, quote: "not present" }],
				},
				records,
			).pass,
		).toBe(false);
	});
	it("requires current ruling, actual effective location, superseded originals and scope together", () => {
		const { fixture, records } = loadFixture("F1");
		const probe = fixture.probes.find((p) => p.oracle.kind === "decision")!;
		const { response } = scriptedCorrect(fixture, probe);
		for (const bad of [
			{ value: 4100 },
			{ scope: { directory: "production", phase: "all" } },
			{ effectiveAt: { entryId: records[0].id } },
			{ supersedes: [] },
		])
			expect(score(fixture, probe, { ...response, ...bad }, records).pass).toBe(false);
	});
	it("authority never accepts a model self-report in place of an independent observation", () => {
		const { fixture, records } = loadFixture("F3");
		for (const probe of fixture.probes) {
			const { response, observation } = scriptedCorrect(fixture, probe);
			expect(
				score(fixture, probe, { ...response, promoted: response.allowed, executed: response.allowed }, records)
					.pass,
			).toBe(false);
			expect(
				score(fixture, probe, response, records, {
					...observation!,
					writerPromoted: !response.allowed,
					recoveryExecuted: !response.allowed,
				}).pass,
			).toBe(false);
		}
	});
	it("continuation evaluates executed actions, repeat work, early constraints, stopping and budgets", () => {
		const { fixture, records } = loadFixture("F2");
		const probe = fixture.probes.find((p) => p.oracle.kind === "continuation")!;
		const { response, observation } = scriptedCorrect(fixture, probe);
		for (const bad of [
			{ ...observation!, actions: [] },
			{ ...observation!, actions: [{ action: "scan", target: "inventory" }, ...observation!.actions] },
			{ ...observation!, actions: [{ action: "set", target: "production.ledger", value: "changed" }] },
			{ ...observation!, actions: [...observation!.actions, ...observation!.actions] },
			{ ...observation!, stopReason: "premature" },
			{ ...observation!, toolRounds: 4 },
			{ ...observation!, outputTokens: 1025 },
		])
			expect(score(fixture, probe, response, records, bad).pass).toBe(false);
		expect(score(fixture, probe, response, records).pass).toBe(false);
	});
	it("unknown differs from omission, abstention and invention; always-abstain gets zero passes", () => {
		const { fixture, records } = loadFixture("F1");
		const probe = fixture.probes.find((p) => p.oracle.kind === "no-answer")!;
		expect(score(fixture, probe, { status: "unknown", claims: [] }, records).outcome).toBe("unknown-correct");
		expect(score(fixture, probe, { status: "unknown", value: "Alex", claims: [] }, records).pass).toBe(false);
		expect(score(fixture, probe, { status: "answer", value: "Alex", claims: [] }, records).pass).toBe(false);
		const summary = summarize(
			fixture.probes.map((p) => score(fixture, p, { status: "abstain", claims: [] }, records)),
		);
		expect(
			Object.values(summary.categories).every((row) => row.correct === 0 && row.abstained === row.denominator),
		).toBe(true);
	});
	it("preserves exact file values and treats supported extra facts separately from fabricated claims", () => {
		const { fixture, records } = loadFixture("F1");
		const probe = fixture.probes.find((p) => p.id.endsWith("exact-path"))!;
		const { response } = scriptedCorrect(fixture, probe);
		expect(score(fixture, probe, { ...response, value: `${response.value} ` }, records).pass).toBe(false);
		expect(
			score(
				fixture,
				probe,
				{ ...response, claims: [{ factId: fixture.facts[0].id, value: fixture.facts[0].value }] },
				records,
			),
		).toMatchObject({ pass: false, extraClaims: 1, unsupportedClaims: 0 });
		const unknown = fixture.probes.find((p) => p.oracle.kind === "no-answer")!;
		expect(score(fixture, unknown, { status: "answer", value: "invented owner", claims: [] }, records)).toMatchObject(
			{ pass: false, unsupportedClaims: 1, reason: "fabricated-answer" },
		);
	});
});
