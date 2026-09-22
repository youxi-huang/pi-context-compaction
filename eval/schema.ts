import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const FIXTURE_VERSION = "0.3-fixtures.1";
export const SCORER_VERSION = "0.3-scorer.1";
export const RUNTIME_PIN = "149e253cebc56b8e732022e79c294fce5ebb5cbc";
const id = Type.String({ minLength: 1 });
const strings = Type.Array(id, { uniqueItems: true });
const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);
const scope = Type.Object({ directory: id, phase: id }, { additionalProperties: false });
const evidence = Type.Object({ entryId: id, quote: id }, { additionalProperties: false });
const evidenceSets = Type.Array(Type.Array(evidence, { minItems: 1 }), { minItems: 1 });
const fact = Type.Object(
	{
		id,
		value: scalar,
		valueType: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")]),
		unit: id,
		normalization: Type.Union([
			Type.Literal("exact"),
			Type.Literal("trim"),
			Type.Literal("casefold"),
			Type.Literal("numeric"),
		]),
		validAt: id,
		source: evidence,
	},
	{ additionalProperties: false },
);
const decision = Type.Object(
	{ id, effectiveAt: id, value: scalar, scope, supersedes: strings, evidence: evidenceSets },
	{ additionalProperties: false },
);
const authority = Type.Object(
	{
		id,
		pairId: id,
		variant: Type.Union([Type.Literal("allowed"), Type.Literal("denied")]),
		pattern: Type.Union([
			Type.Literal("adoption"),
			Type.Literal("delegation"),
			Type.Literal("directory-scope"),
			Type.Literal("phase-scope"),
			Type.Literal("revocation"),
			Type.Literal("new-ruling"),
			Type.Literal("tool-impersonation"),
			Type.Literal("assistant-impersonation"),
			Type.Literal("field-placement"),
			Type.Literal("writer-control"),
		]),
		inputLayer: Type.Union([
			Type.Literal("original-message"),
			Type.Literal("writer-control"),
			Type.Literal("candidate-note"),
		]),
		sourceRole: Type.Union([
			Type.Literal("user"),
			Type.Literal("assistant"),
			Type.Literal("toolResult"),
			Type.Literal("internal"),
		]),
		purpose: Type.Union([
			Type.Literal("instruction"),
			Type.Literal("quoted-proposal"),
			Type.Literal("tool-evidence"),
			Type.Literal("internal-control"),
			Type.Literal("candidate-claim"),
		]),
		authorization: Type.Union([Type.Literal("adopted"), Type.Literal("delegated"), Type.Literal("unapproved")]),
		scope,
		attemptedScope: scope,
		revoked: Type.Boolean(),
		effectiveAt: id,
		sources: strings,
		text: id,
		action: id,
		expectedAllowed: Type.Boolean(),
		recoveryField: Type.Union([Type.Literal("nextSteps"), Type.Literal("state"), Type.Literal("gaps")]),
		measurement: Type.Union([Type.Literal("writer-and-recovery"), Type.Literal("offline-injection-only")]),
	},
	{ additionalProperties: false },
);
export const actionSchema = Type.Object(
	{ action: id, target: id, value: Type.Optional(scalar) },
	{ additionalProperties: false },
);
const state = Type.Record(Type.String(), scalar);
const continuation = Type.Object(
	{
		initial: state,
		firstAction: actionSchema,
		permitted: Type.Array(actionSchema, { minItems: 1 }),
		completedActions: strings,
		forbiddenTargets: strings,
		goal: state,
		maxActions: Type.Integer({ minimum: 1 }),
		maxToolRounds: Type.Integer({ minimum: 1 }),
		maxOutputTokens: Type.Integer({ minimum: 1 }),
		stopReason: Type.Literal("completed"),
	},
	{ additionalProperties: false },
);
const oracle = Type.Union([
	Type.Object({ kind: Type.Literal("fact"), factId: id }, { additionalProperties: false }),
	Type.Object(
		{
			kind: Type.Literal("support"),
			claim: scalar,
			allowed: evidenceSets,
			counterEvidence: Type.Array(evidence),
			jointRequired: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("decision"), decisionId: id }, { additionalProperties: false }),
	Type.Object(
		{
			kind: Type.Literal("authority"),
			authorityId: id,
			dimension: Type.Union([Type.Literal("writer-promotion"), Type.Literal("recovery-action")]),
		},
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("continuation"), contract: continuation }, { additionalProperties: false }),
	Type.Object(
		{ kind: Type.Literal("no-answer"), rule: Type.Literal("explicit-unknown-only"), forbiddenClaims: strings },
		{ additionalProperties: false },
	),
]);
export const fixtureSchema = Type.Object(
	{
		version: Type.Literal(FIXTURE_VERSION),
		id: Type.Union([Type.Literal("F1"), Type.Literal("F2"), Type.Literal("F3")]),
		description: id,
		tokenMetric: Type.Literal("sum-ceil-utf8-source-bytes-div-3"),
		sourceTokens: Type.Integer({ minimum: 1 }),
		native: Type.Object(
			{
				label: Type.Union([Type.Literal("native-default"), Type.Literal("configured-native")]),
				keepRecentTokens: Type.Integer({ minimum: 0 }),
				reason: id,
			},
			{ additionalProperties: false },
		),
		triggers: Type.Array(
			Type.Object(
				{
					id,
					afterEntryId: id,
					cumulativeSourceTokens: Type.Integer(),
					semantics: Type.Literal("manual-after-completed-turn"),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		facts: Type.Array(fact),
		decisions: Type.Array(decision),
		authorities: Type.Array(authority),
		probes: Type.Array(
			Type.Object(
				{
					id,
					checkpoint: id,
					prompt: id,
					target: Type.Union([Type.Literal("task"), Type.Literal("writer-artifact")]),
					oracle,
					crossCheckpoint: Type.Boolean(),
					earlyFactIds: strings,
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		judge: Type.Object(
			{ enabled: Type.Literal(false), coverage: Type.Literal(0), reason: id },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type Fixture = Static<typeof fixtureSchema>;
export type Fact = Fixture["facts"][number];
export type Authority = Fixture["authorities"][number];
export type Probe = Fixture["probes"][number];
export type Action = Static<typeof actionSchema>;
export type TaskContract = Static<typeof continuation>;
export type Scalar = Static<typeof scalar>;
export type Evidence = Static<typeof evidence>;

/** Adapter-neutral source view. Pi JSONL is converted only in the adapter. */
export interface SourceRecord {
	id: string;
	parentId: string | null;
	role: string;
	text: string;
}
export function assertFixture(value: unknown): asserts value is Fixture {
	if (!Check(fixtureSchema, value)) throw new Error("EVAL_FIXTURE_SCHEMA");
}
export function sourceTokens(records: readonly SourceRecord[]): number {
	return records.reduce((sum, record) => sum + Math.ceil(new TextEncoder().encode(record.text).length / 3), 0);
}
export function validateMappings(fixture: Fixture, records: readonly SourceRecord[]): void {
	const byId = new Map(records.map((record, index) => [record.id, { record, index }]));
	if (byId.size !== records.length) throw new Error("EVAL_DUPLICATE_SOURCE");
	for (const [index, record] of records.entries())
		if (record.parentId !== (records[index - 1]?.id ?? null)) throw new Error("EVAL_ANCESTOR_CHAIN");
	const requireSource = (entryId: string) => {
		const found = byId.get(entryId);
		if (!found || !found.record.text) throw new Error(`EVAL_SOURCE:${entryId}`);
		return found;
	};
	const requireEvidence = (item: Evidence) => {
		if (!requireSource(item.entryId).record.text.includes(item.quote)) throw new Error("EVAL_QUOTE");
	};
	for (const fact of fixture.facts) {
		if (typeof fact.value !== fact.valueType) throw new Error("EVAL_FACT_TYPE");
		requireEvidence(fact.source);
		if (requireSource(fact.source.entryId).index > requireSource(fact.validAt).index)
			throw new Error("EVAL_FACT_TIME");
	}
	for (const decision of fixture.decisions) {
		const current = requireSource(decision.effectiveAt).index;
		for (const old of decision.supersedes)
			if (requireSource(old).index >= current) throw new Error("EVAL_SUPERSEDES_ORDER");
		for (const set of decision.evidence)
			for (const item of set) {
				requireEvidence(item);
				if (requireSource(item.entryId).index > current) throw new Error("EVAL_DECISION_TIME");
			}
	}
	for (const item of fixture.authorities) {
		requireSource(item.effectiveAt);
		for (const source of item.sources)
			if (requireSource(source).index > requireSource(item.effectiveAt).index)
				throw new Error("EVAL_AUTHORITY_TIME");
		if (item.inputLayer !== "original-message" && item.measurement !== "offline-injection-only")
			throw new Error("EVAL_INPUT_LAYER");
	}
	if (sourceTokens(records) !== fixture.sourceTokens) throw new Error("EVAL_SIZE");
	let previous = -1;
	for (const trigger of fixture.triggers) {
		const boundary = requireSource(trigger.afterEntryId);
		if (
			boundary.index <= previous ||
			boundary.record.role !== "assistant" ||
			sourceTokens(records.slice(0, boundary.index + 1)) !== trigger.cumulativeSourceTokens
		)
			throw new Error("EVAL_TRIGGER");
		previous = boundary.index;
	}
	const ids = [
		...fixture.facts,
		...fixture.decisions,
		...fixture.authorities,
		...fixture.probes,
		...fixture.triggers,
	].map((item) => item.id);
	if (new Set(ids).size !== ids.length) throw new Error("EVAL_DUPLICATE_ANNOTATION");
	for (const probe of fixture.probes) {
		if (
			(probe.target === "writer-artifact") !==
			(probe.oracle.kind === "authority" && probe.oracle.dimension === "writer-promotion")
		)
			throw new Error("EVAL_PROBE_TARGET");
		const checkpoint = fixture.triggers.find((trigger) => trigger.id === probe.checkpoint);
		if (!checkpoint) throw new Error("EVAL_PROBE_CHECKPOINT");
		const boundary = requireSource(checkpoint.afterEntryId).index;
		let referenced: string[] = [];
		const oracle = probe.oracle;
		switch (oracle.kind) {
			case "fact": {
				const item = fixture.facts.find((fact) => fact.id === oracle.factId);
				if (!item) throw new Error("EVAL_FACT");
				referenced = [item.source.entryId, item.validAt];
				break;
			}
			case "decision": {
				const item = fixture.decisions.find((decision) => decision.id === oracle.decisionId);
				if (!item) throw new Error("EVAL_DECISION");
				referenced = [item.effectiveAt, ...item.supersedes, ...item.evidence.flat().map((e) => e.entryId)];
				break;
			}
			case "authority": {
				const item = fixture.authorities.find((authority) => authority.id === oracle.authorityId);
				if (!item) throw new Error("EVAL_AUTHORITY");
				referenced = [item.effectiveAt, ...item.sources];
				break;
			}
			case "support":
				if (
					oracle.allowed.some((set) =>
						oracle.jointRequired ? new Set(set.map((item) => item.entryId)).size < 2 : set.length !== 1,
					)
				)
					throw new Error("EVAL_JOINT_EVIDENCE");
				for (const item of [...oracle.allowed.flat(), ...oracle.counterEvidence]) requireEvidence(item);
				referenced = [...oracle.allowed.flat(), ...oracle.counterEvidence].map((e) => e.entryId);
				break;
		}
		for (const factId of probe.earlyFactIds) {
			const fact = fixture.facts.find((f) => f.id === factId);
			if (!fact) throw new Error("EVAL_EARLY_FACT");
			referenced.push(fact.source.entryId);
		}
		if (referenced.some((entryId) => requireSource(entryId).index > boundary)) throw new Error("EVAL_FUTURE_GOLD");
	}
}
