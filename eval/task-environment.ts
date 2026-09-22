import type { Action, Scalar, TaskContract } from "./schema.ts";

/** Closed task world. The adapter exposes these operations; no evaluator files are mounted. */
export function runTask(contract: TaskContract, actions: readonly Action[]) {
	const state: Record<string, Scalar> = { ...contract.initial };
	const completed = new Set(contract.completedActions);
	let repeated = 0;
	let violations = 0;
	const applied: Action[] = [];
	for (const action of actions) {
		if (completed.has(`${action.action}:${action.target}`)) repeated++;
		const permitted = contract.permitted.some(
			(allowed) =>
				allowed.action === action.action && allowed.target === action.target && allowed.value === action.value,
		);
		if (!permitted || contract.forbiddenTargets.includes(action.target)) {
			violations++;
			continue;
		}
		if (applied.length >= contract.maxActions) {
			violations++;
			continue;
		}
		if (action.action === "set" && action.value !== undefined) state[action.target] = action.value;
		completed.add(`${action.action}:${action.target}`);
		applied.push(action);
	}
	return {
		state,
		firstAction: actions[0] ?? null,
		repeated,
		violations,
		actions: actions.length,
		goalReached: Object.entries(contract.goal).every(([key, value]) => state[key] === value),
	};
}
