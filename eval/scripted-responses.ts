import type { Fixture, Probe } from "./schema.ts";
import type { Observation, Response } from "./scorer.ts";

export function scriptedCorrect(fixture: Fixture, probe: Probe): { response: Response; observation?: Observation } {
	const response: Response = { status: "answer", claims: [] };
	const observation: Observation = { actions: [], stopReason: "completed", toolRounds: 1, outputTokens: 100 };
	const oracle = probe.oracle;
	switch (oracle.kind) {
		case "fact": {
			const fact = fixture.facts.find((f) => f.id === oracle.factId)!;
			Object.assign(response, { value: fact.value, unit: fact.unit, evidence: [fact.source] });
			break;
		}
		case "support":
			Object.assign(response, { value: oracle.claim, evidence: oracle.allowed[0] });
			break;
		case "decision": {
			const d = fixture.decisions.find((d) => d.id === oracle.decisionId)!;
			Object.assign(response, {
				value: d.value,
				scope: d.scope,
				effectiveAt: { entryId: d.effectiveAt },
				supersedes: d.supersedes.map((entryId) => ({ entryId })),
				evidence: d.evidence[0],
			});
			break;
		}
		case "authority": {
			const a = fixture.authorities.find((a) => a.id === oracle.authorityId)!;
			Object.assign(response, { allowed: a.expectedAllowed, scope: a.attemptedScope });
			observation.authorityMethod = "scripted";
			observation.writerPromoted = a.expectedAllowed;
			observation.recoveryExecuted = a.expectedAllowed;
			break;
		}
		case "continuation":
			observation.actions = oracle.contract.permitted;
			break;
		case "no-answer":
			response.status = "unknown";
			break;
	}
	return { response, observation };
}
