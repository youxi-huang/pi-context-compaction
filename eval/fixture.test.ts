import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateFixtures } from "./generate-fixtures.ts";
import { assertFixture, validateMappings } from "./schema.ts";
import { evalRoot, loadFixture } from "./test-utils.ts";

describe("versioned synthetic fixture integrity", () => {
	it("reproduces every checked-in byte and hash without a model", () => {
		for (const [name, text] of generateFixtures())
			expect(readFileSync(join(evalRoot, "fixtures", name), "utf8")).toBe(text);
		const manifest = JSON.parse(readFileSync(join(evalRoot, "fixtures/manifest.json"), "utf8"));
		for (const [name, hash] of Object.entries(manifest.files))
			expect(
				createHash("sha256")
					.update(readFileSync(join(evalRoot, "fixtures", name)))
					.digest("hex"),
			).toBe(hash);
	});
	for (const name of ["F1", "F2", "F3"])
		it(`${name} validates source mappings, chain, schema and completed-turn triggers`, () => {
			const { fixture, records, branch } = loadFixture(name);
			expect(() => assertFixture(fixture)).not.toThrow();
			expect(() => validateMappings(fixture, records)).not.toThrow();
			for (const trigger of fixture.triggers) {
				const entry = branch.find((e) => e.id === trigger.afterEntryId)!;
				expect(entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason).toBe(
					"stop",
				);
			}
			const serialized = JSON.stringify(fixture) + JSON.stringify(branch);
			expect(serialized).not.toMatch(/\/Users\/|\/home\/[^/]+|sk-proj-|BEGIN PRIVATE KEY/);
			const toolCalls = branch.flatMap((e) =>
				e.type === "message" && e.message.role === "assistant"
					? e.message.content.filter((c) => c.type === "toolCall").map((c) => c.id)
					: [],
			);
			const results = branch.flatMap((e) =>
				e.type === "message" && e.message.role === "toolResult" ? [e.message.toolCallId] : [],
			);
			expect(results).toEqual(toolCalls);
		});
	it("F1 retains 28k/30k boundaries and F2 schedules >80k before its first checkpoint", () => {
		const f1 = loadFixture("F1").fixture,
			f2 = loadFixture("F2").fixture;
		expect(f1.triggers.map((t) => t.cumulativeSourceTokens)).toEqual([28000, 30000]);
		expect(f2.triggers.map((t) => t.cumulativeSourceTokens)).toEqual([82000, 91000, 100000]);
		for (const name of ["F1", "F2"]) {
			const { fixture, records } = loadFixture(name);
			expect(fixture.native).toMatchObject({ label: "native-default", keepRecentTokens: 20000 });
			expect(new Set(fixture.probes.map((p) => p.oracle.kind)).size).toBe(6);
			expect(fixture.probes.filter((p) => p.crossCheckpoint).length).toBeGreaterThan(0);
			for (const record of records.filter((r) => r.role === "user")) {
				expect(record.text).toContain("Approved latency:");
				expect(record.text).toContain("proposal");
				expect(record.text.split("Record digest: ")[1].length).toBeLessThanOrEqual(250);
			}
		}
	});
	it("F3 covers every permission pair, input layer and recovery field", () => {
		const { fixture } = loadFixture("F3");
		expect(fixture.authorities).toHaveLength(24);
		expect(new Set(fixture.authorities.map((a) => a.pattern)).size).toBe(10);
		expect(new Set(fixture.authorities.map((a) => a.inputLayer))).toEqual(
			new Set(["original-message", "writer-control", "candidate-note"]),
		);
		for (const pair of new Set(fixture.authorities.map((a) => a.pairId))) {
			const members = fixture.authorities.filter((a) => a.pairId === pair);
			expect(members.map((a) => a.expectedAllowed).sort()).toEqual([false, true]);
		}
		for (const field of ["state", "nextSteps", "gaps"])
			expect(
				fixture.authorities.some(
					(a) => a.pattern === "field-placement" && a.recoveryField === field && !a.expectedAllowed,
				),
			).toBe(true);
		for (const authority of fixture.authorities) {
			const scopeMatches = JSON.stringify(authority.scope) === JSON.stringify(authority.attemptedScope);
			expect(authority.expectedAllowed).toBe(
				authority.authorization !== "unapproved" && !authority.revoked && scopeMatches,
			);
			expect(
				fixture.probes
					.filter((p) => p.oracle.kind === "authority" && p.oracle.authorityId === authority.id)
					.map((p) => (p.oracle.kind === "authority" ? p.oracle.dimension : null))
					.sort(),
			).toEqual(["recovery-action", "writer-promotion"]);
		}
	});
	it("rejects malformed gold, broken ancestry, future facts, invalid quotes and reversed rulings", () => {
		const { fixture, records } = loadFixture("F1");
		expect(() => assertFixture({ ...fixture, sourceTokens: "30000" })).toThrow("EVAL_FIXTURE_SCHEMA");
		const broken = structuredClone(records);
		broken[1].parentId = null;
		expect(() => validateMappings(fixture, broken)).toThrow("EVAL_ANCESTOR_CHAIN");
		const quote = structuredClone(fixture);
		quote.facts[0].source.quote = "not in the transcript";
		expect(() => validateMappings(quote, records)).toThrow("EVAL_QUOTE");
		const future = structuredClone(fixture);
		future.probes[0].oracle = { kind: "fact", factId: fixture.facts.at(-1)!.id };
		expect(() => validateMappings(future, records)).toThrow("EVAL_FUTURE_GOLD");
		const ruling = structuredClone(fixture);
		ruling.decisions[0].supersedes = [records.at(-1)!.id];
		expect(() => validateMappings(ruling, records)).toThrow("EVAL_SUPERSEDES_ORDER");
	});
});
