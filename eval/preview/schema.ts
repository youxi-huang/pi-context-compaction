import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

/** The preview evaluation set; independent of the frozen F1 to F3 fixtures and their scorer. */
export const PREVIEW_FIXTURE_VERSION = "0.5-preview-fixtures.1";
/**
 * P4, added for 0.6.0 under its own version and manifest, so P1 to P3 keep their bytes and their pins: sessions
 * whose answers sit in repeated file reads and long consumed tool results, the entries a deterministic reduction
 * would replace.
 */
export const P4_FIXTURE_VERSION = "0.6-preview-fixtures.1";
/**
 * P5, the long route, under its own version and manifest: one session whose cuts sit near the 150k, 184k, 204k and
 * 256k context lines, for first compactions on 200k and 272k routes. P1 to P4 keep their bytes and pins.
 */
export const P5_FIXTURE_VERSION = "0.7-preview-fixtures-long.1";
export const PREVIEW_SCORER_VERSION = "0.5-preview-scorer.2";

const id = Type.String({ minLength: 1 });

/**
 * Evaluator-only probe kinds. They are reported, never sent: a probe's prompt does not name its kind, and the runner
 * passes no category to the runtime.
 */
export const PROBE_KINDS = [
	"fact",
	"current",
	"previous",
	"count",
	"constraint",
	"forbidden",
	"withdrawn",
	"attribution",
	"authority",
	"absent",
	"continuation",
] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

const expected = Type.Union([
	Type.Object(
		{ type: Type.Literal("number"), value: Type.Number(), unit: Type.Optional(id) },
		{ additionalProperties: false },
	),
	Type.Object({ type: Type.Literal("boolean"), value: Type.Boolean() }, { additionalProperties: false }),
	/** Matched after trimming, case folding and dropping a final period; any listed form is accepted. */
	Type.Object(
		{ type: Type.Literal("text"), accept: Type.Array(id, { minItems: 1 }) },
		{ additionalProperties: false },
	),
	/** One option letter of the prompt's choices. */
	Type.Object({ type: Type.Literal("choice"), value: Type.String({ pattern: "^[A-D]$" }) }, { additionalProperties: false }),
	/** The records do not contain the answer: only an explicit unknown is correct. */
	Type.Object({ type: Type.Literal("unknown") }, { additionalProperties: false }),
]);

export const previewProbeSchema = Type.Object(
	{
		id,
		checkpoint: id,
		// Spelled out: a mapped array would lose the literal types.
		kind: Type.Union([
			Type.Literal("fact"),
			Type.Literal("current"),
			Type.Literal("previous"),
			Type.Literal("count"),
			Type.Literal("constraint"),
			Type.Literal("forbidden"),
			Type.Literal("withdrawn"),
			Type.Literal("attribution"),
			Type.Literal("authority"),
			Type.Literal("absent"),
			Type.Literal("continuation"),
		]),
		prompt: id,
		expected,
		/** Entries any one of which supports the answer; empty for absent answers. */
		evidence: Type.Array(id),
		/** The answer's source predates an earlier checkpoint, so it has crossed at least one compaction. */
		crossCheckpoint: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const previewFixtureSchema = Type.Object(
	{
		version: Type.Union([Type.Literal(PREVIEW_FIXTURE_VERSION), Type.Literal(P4_FIXTURE_VERSION), Type.Literal(P5_FIXTURE_VERSION)]),
		id,
		description: id,
		tokenMetric: Type.Literal("sum-ceil-utf8-source-bytes-div-3"),
		sourceTokens: Type.Integer({ minimum: 1 }),
		/** Manual compaction points, each after a completed assistant turn, in order. */
		checkpoints: Type.Array(
			Type.Object(
				{ id, afterEntryId: id, cumulativeSourceTokens: Type.Integer({ minimum: 1 }) },
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		probes: Type.Array(previewProbeSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export type PreviewFixture = Static<typeof previewFixtureSchema>;
export type PreviewProbe = Static<typeof previewProbeSchema>;
export type Expected = PreviewProbe["expected"];

/** The answer contract every probe prompt states; the scorer reads the last JSON object of the reply. */
export const answerSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("answer"), Type.Literal("unknown")]),
		value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
		evidence: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);
export type Answer = Static<typeof answerSchema>;

export const ANSWER_CONTRACT =
	'Answer from this session\'s records only; do not run commands or read files. Reply with exactly one JSON object and nothing else: {"status":"answer","value":<string, number or boolean>,"evidence":["<entry ID>", ...]} citing the original entries that support the answer, or {"status":"unknown"} when the records do not contain the answer.';

export function assertPreviewFixture(value: unknown): asserts value is PreviewFixture {
	if (!Check(previewFixtureSchema, value)) throw new Error("EVAL_PREVIEW_FIXTURE_SCHEMA");
}
