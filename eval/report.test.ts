import { writeFileSync } from "node:fs";
import http from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { note } from "./pi/offline-host.ts";
import { inspectReferences } from "./pi/structural.ts";
import { buildReport } from "./report.ts";
import { type Score, score } from "./scorer.ts";
import { scriptedCorrect } from "./scripted-responses.ts";
import { artifactDirectory, json, loadFixture } from "./test-utils.ts";

it("generates JSON and Markdown with separate semantic/structural numbers and explicit denominators", () => {
	const root = artifactDirectory("stage1-report-");
	const scores: Score[] = [];
	for (const name of ["F1", "F2", "F3"]) {
		const { fixture, records } = loadFixture(name);
		for (const probe of fixture.probes) {
			const { response, observation } = scriptedCorrect(fixture, probe);
			scores.push(score(fixture, probe, response, records, observation));
		}
	}
	const { fixture, records, branch } = loadFixture("F1");
	const cp = {
		type: "compaction" as const,
		id: "counterexample-checkpoint",
		parentId: branch.at(-1)!.id,
		timestamp: "2026-01-01",
		summary: "Old summary",
		firstKeptEntryId: branch[0].id,
		tokensBefore: 1,
	};
	const bad = note(branch[0].id);
	bad.state[0].supersedes = [cp.id];
	const findings = [
		inspectReferences(note(cp.id), [...branch, cp]),
		inspectReferences(bad, [...branch, cp]),
		inspectReferences(note("future"), branch),
		inspectReferences(note(branch[0].id), branch),
	];
	const built = buildReport(scores, findings);
	expect(built.report.structural).toMatchObject({
		total: 4,
		implementationAccepted: 2,
		benchmarkAccepted: 1,
		evidenceUnreadable: 1,
	});
	expect(built.report.summary.planned).toBe(scores.length);
	expect(built.markdown).toContain("not a provider recovery baseline");
	expect(built.markdown).toContain("implementation accepted 2/4; benchmark accepted 1/4; evidence-unreadable 1");
	json(join(root, "report.json"), built.report);
	writeFileSync(join(root, "report.md"), built.markdown);
	const authority = fixture.probes.find((p) => p.oracle.kind === "authority")!;
	const { response, observation } = scriptedCorrect(fixture, authority);
	const semantic = score(fixture, authority, response, records, {
		...observation!,
		authorityMethod: "manual-semantic",
	});
	expect(semantic.adjudication).toBe("semantic-review");
	const separated = buildReport([semantic], []);
	expect(separated.report.summary.categories.authority).toMatchObject({
		correct: 0,
		semanticReviewed: 1,
		semanticPassed: 1,
		denominator: 0,
	});
});

it("blocks actual fetch, HTTP and socket paths under explicit zero-call configuration", () => {
	expect(process.env.PI_OFFLINE).toBe("1");
	expect(process.env.EVAL_MODEL_CALL_BUDGET).toBe("0");
	expect(process.env.EVAL_PROVIDER_MODE).toBe("scripted");
	expect(() => fetch("https://eval.invalid")).toThrow("EVAL_NETWORK_FORBIDDEN");
	expect(() => http.get("http://eval.invalid")).toThrow("EVAL_NETWORK_FORBIDDEN");
	expect(() => connect(443, "eval.invalid")).toThrow("EVAL_NETWORK_FORBIDDEN");
});
