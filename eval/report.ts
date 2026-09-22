import type { StructuralFinding } from "./pi/structural.ts";
import { summarizeReferences } from "./pi/structural.ts";
import { FIXTURE_VERSION, RUNTIME_PIN, SCORER_VERSION } from "./schema.ts";
import { type Score, summarize } from "./scorer.ts";

export function buildReport(scores: readonly Score[], findings: readonly StructuralFinding[]) {
	const summary = summarize(scores);
	const structural = summarizeReferences(findings);
	const report = {
		metadata: {
			fixtureVersion: FIXTURE_VERSION,
			scorerVersion: SCORER_VERSION,
			runtimePin: RUNTIME_PIN,
			mode: "offline-scripted-regression",
			realModelCalls: 0,
			semanticQualityMeasurement: false,
			llmJudgeCoverage: 0,
		},
		summary,
		structural,
		scores,
	};
	const markdown = `# Offline evaluation regression report\n\nThis is a scripted scoring/structure regression, not a provider recovery baseline.\n\nRuntime: ${RUNTIME_PIN}. Fixtures: ${FIXTURE_VERSION}. Scorer: ${SCORER_VERSION}. Real model calls: 0.\n\n| Class | Planned | Correct deterministic | Incorrect | Abstained | Omitted | Blocked | Semantic reviewed | Deterministic denominator |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${Object.entries(
		summary.categories,
	)
		.map(
			([kind, row]) =>
				`| ${kind} | ${row.planned} | ${row.correct} | ${row.incorrect} | ${row.abstained} | ${row.omitted} | ${row.blocked} | ${row.semanticReviewed} | ${row.denominator} |`,
		)
		.join(
			"\n",
		)}\n\nStructure: implementation accepted ${structural.implementationAccepted}/${structural.total}; benchmark accepted ${structural.benchmarkAccepted}/${structural.total}; evidence-unreadable ${structural.evidenceUnreadable}. These two acceptance counts must not be merged.\n`;
	const cohorts = `\nAuthority observation dimensions (never combined):\n\n| Dimension | Planned | Injection-only subset | Deterministic correct | Semantic reviewed |\n| --- | ---: | ---: | ---: | ---: |\n${Object.entries(
		summary.authorityDimensions,
	)
		.map(
			([dimension, row]) =>
				`| ${dimension} | ${row.planned} | ${row.injectionOnly} | ${row.correctDeterministic} | ${row.semanticReviewed} |`,
		)
		.join(
			"\n",
		)}\n\nInjection-only observations overall: ${summary.injectionOnly}/${summary.planned}. They are not provider-generated writer outcomes.\n`;
	return { report, markdown: markdown + cohorts };
}
