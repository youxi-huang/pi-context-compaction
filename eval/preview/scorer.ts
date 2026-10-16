import { Check } from "typebox/value";
import {
	type Answer,
	answerSchema,
	PREVIEW_SCORER_VERSION,
	PROBE_KINDS,
	type PreviewFixture,
	type PreviewProbe,
	type ProbeKind,
} from "./schema.ts";

export type Outcome =
	| "correct"
	| "incorrect"
	| "abstained"
	| "unknown-correct"
	| "fabricated"
	| "invalid"
	| "blocked";

export interface ProbeScore {
	probeId: string;
	fixtureId: string;
	kind: ProbeKind;
	crossCheckpoint: boolean;
	outcome: Outcome;
	pass: boolean;
	/** A passing value that carries prose after the answer, such as "No. It was disabled." for `false`. */
	prose: boolean;
	/** The answer cites at least one entry the gold accepts as support. */
	supported: boolean;
	/** Cited IDs that are not entries of the fixture's session. */
	unknownEvidence: number;
}

/** The last JSON object in a reply; models sometimes wrap it in prose or a code fence. */
export function parseAnswer(reply: string): Answer | undefined {
	const read = (candidate: string): Answer | undefined => {
		try {
			const value: unknown = JSON.parse(candidate);
			return Check(answerSchema, value) ? value : undefined;
		} catch {
			return undefined;
		}
	};
	const whole = read(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
	if (whole) return whole;
	// Bounded: try closing braces from the end, each with opening braces before it, at most 200 slices.
	const before = (char: string, index: number) => (index > 0 ? reply.lastIndexOf(char, index - 1) : -1);
	let tries = 0;
	for (let end = reply.lastIndexOf("}"); end >= 0 && tries < 200; end = before("}", end))
		for (let start = before("{", end + 1); start >= 0 && tries < 200; start = before("{", start), tries++) {
			const value = read(reply.slice(start, end + 1));
			if (value) return value;
		}
	return undefined;
}

const text = (value: unknown) =>
	String(value)
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/\.$/, "");

/** `strict`: the value is the answer alone. `prose`: the value leads with the answer and goes on in prose. */
type Match = "strict" | "prose" | undefined;

/** True when `value` starts with `form` followed by the end or by a character that cannot continue a word. */
const leads = (value: string, form: string) =>
	value.startsWith(form) && (value.length === form.length || !/[\p{L}\p{N}_]/u.test(value[form.length]));

function matches(probe: PreviewProbe, value: Answer["value"]): Match {
	const expected = probe.expected;
	switch (expected.type) {
		case "number": {
			if (typeof value === "number") return value === expected.value ? "strict" : undefined;
			if (typeof value !== "string") return undefined;
			if (Number(value.trim()) === expected.value) return "strict";
			const lead = value.trim().match(/^-?\d+(?:\.\d+)?(?![\d.])/);
			return lead && Number(lead[0]) === expected.value ? "prose" : undefined;
		}
		case "boolean": {
			if (typeof value === "boolean") return value === expected.value ? "strict" : undefined;
			const words = expected.value ? ["yes", "true"] : ["no", "false"];
			const word = text(value);
			if (words.includes(word)) return "strict";
			return words.some((form) => leads(word, form)) ? "prose" : undefined;
		}
		case "text": {
			if (value === undefined) return undefined;
			const forms = expected.accept.map(text);
			const given = text(value);
			if (forms.includes(given)) return "strict";
			return forms.some((form) => leads(given, form)) ? "prose" : undefined;
		}
		case "choice": {
			const letter = String(value ?? "")
				.trim()
				.match(/^([A-Da-d])(?![A-Za-z])/);
			return letter?.[1].toUpperCase() === expected.value ? "strict" : undefined;
		}
		case "unknown":
			return undefined;
	}
}

/** A missing reply is `blocked` when the runner could not ask, `invalid` when the reply has no answer object. */
export function scoreProbe(
	fixture: PreviewFixture,
	probe: PreviewProbe,
	reply: string | undefined,
	entryIds: ReadonlySet<string>,
): ProbeScore {
	const base = {
		probeId: probe.id,
		fixtureId: fixture.id,
		kind: probe.kind,
		crossCheckpoint: probe.crossCheckpoint,
		supported: false,
		unknownEvidence: 0,
		prose: false,
	};
	if (reply === undefined) return { ...base, outcome: "blocked", pass: false };
	const answer = parseAnswer(reply);
	if (!answer) return { ...base, outcome: "invalid", pass: false };
	const evidence = answer.evidence ?? [];
	const scored = {
		...base,
		supported: evidence.some((id) => probe.evidence.includes(id)),
		unknownEvidence: evidence.filter((id) => !entryIds.has(id)).length,
	};
	if (probe.expected.type === "unknown")
		return answer.status === "unknown"
			? { ...scored, outcome: "unknown-correct", pass: true }
			: { ...scored, outcome: "fabricated", pass: false };
	if (answer.status === "unknown") return { ...scored, outcome: "abstained", pass: false };
	const match = matches(probe, answer.value);
	return { ...scored, outcome: match ? "correct" : "incorrect", pass: match !== undefined, prose: match === "prose" };
}

interface Tally {
	planned: number;
	passed: number;
	correct: number;
	incorrect: number;
	abstained: number;
	unknownCorrect: number;
	fabricated: number;
	invalid: number;
	blocked: number;
	supported: number;
	unknownEvidence: number;
	prose: number;
}

function tally(scores: readonly ProbeScore[]): Tally {
	const count = (outcome: Outcome) => scores.filter((row) => row.outcome === outcome).length;
	return {
		planned: scores.length,
		passed: scores.filter((row) => row.pass).length,
		correct: count("correct"),
		incorrect: count("incorrect"),
		abstained: count("abstained"),
		unknownCorrect: count("unknown-correct"),
		fabricated: count("fabricated"),
		invalid: count("invalid"),
		blocked: count("blocked"),
		supported: scores.filter((row) => row.supported).length,
		unknownEvidence: scores.reduce((sum, row) => sum + row.unknownEvidence, 0),
		prose: scores.filter((row) => row.prose).length,
	};
}

/** Counts with their denominators, overall, by kind and for answers that crossed a compaction. */
export function summarizePreview(scores: readonly ProbeScore[]) {
	return {
		scorerVersion: PREVIEW_SCORER_VERSION,
		overall: tally(scores),
		crossCheckpoint: tally(scores.filter((row) => row.crossCheckpoint)),
		byKind: Object.fromEntries(
			PROBE_KINDS.map((kind) => [kind, tally(scores.filter((row) => row.kind === kind))]).filter(
				([, value]) => (value as Tally).planned > 0,
			),
		),
	};
}
