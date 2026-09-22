import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager.ts";
import { sourceText, validateNote } from "../../packages/coding-agent/src/extensions/context-memory/notes.ts";

export interface StructuralFinding {
	implementation: "accepted" | "rejected";
	benchmark: "accepted" | "rejected";
	classification: "accepted" | "hard-failure" | "evidence-unreadable";
	unreadableIds: string[];
	error?: string;
}
/** Preserve separate runtime/benchmark verdicts, including historical unreadable-reference findings. */
export function inspectReferences(
	candidate: unknown,
	prefix: readonly SessionEntry[],
	hardTokens = 8000,
): StructuralFinding {
	try {
		const note = validateNote(candidate, prefix, hardTokens);
		const byId = new Map(prefix.map((entry) => [entry.id, entry]));
		const unreadableIds = [
			...new Set(
				[note.instructions, note.failedPaths, note.reasons, note.state, note.nextSteps, note.files]
					.flat()
					.flatMap((fact) => [...fact.sources, ...(fact.supersedes ?? [])])
					.filter((id) => !sourceText(byId.get(id)!)),
			),
		];
		return {
			implementation: "accepted",
			benchmark: unreadableIds.length ? "rejected" : "accepted",
			classification: unreadableIds.length ? "evidence-unreadable" : "accepted",
			unreadableIds,
		};
	} catch (error) {
		return {
			implementation: "rejected",
			benchmark: "rejected",
			classification: "hard-failure",
			unreadableIds: [],
			error: String(error),
		};
	}
}
export function summarizeReferences(findings: readonly StructuralFinding[]) {
	return {
		total: findings.length,
		implementationAccepted: findings.filter((f) => f.implementation === "accepted").length,
		implementationRejected: findings.filter((f) => f.implementation === "rejected").length,
		benchmarkAccepted: findings.filter((f) => f.benchmark === "accepted").length,
		benchmarkRejected: findings.filter((f) => f.benchmark === "rejected").length,
		evidenceUnreadable: findings.filter((f) => f.classification === "evidence-unreadable").length,
	};
}
