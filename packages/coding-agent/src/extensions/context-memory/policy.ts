import type { Extension, ToolDefinition } from "../../core/extensions/types.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import { revokeSessionHistory } from "./history.ts";
import { CONTEXT_MEMORY_PATH } from "./identity.ts";

const residents = new WeakSet<Extension>();
const owners = new WeakMap<SessionManager, object>();

export function registerResident(extension: Extension): void {
	residents.add(extension);
}
export function isResident(extension: Extension): boolean {
	return residents.has(extension);
}

/**
 * Orders extensions for `session_before_compact`: other extensions first, the resident last.
 * Observers see the event before the writer runs, and a competing compactor is rejected
 * before the resident spends a writer call.
 */
export function orderCompactionExtensions(extensions: readonly Extension[]): Extension[] {
	return [...extensions.filter((extension) => !isResident(extension)), ...extensions.filter(isResident)];
}

/**
 * Rejects any `session_before_compact` result from a non-resident extension. Handlers that only
 * observe the event and return `undefined` are allowed; a handler that returns a compaction or a
 * cancellation competes with the resident and fails the compaction with an explicit error.
 */
export function assertCompactionResult(extension: Extension, result: unknown): void {
	if (isResident(extension) || result === undefined || result === null) return;
	throw new Error(
		`CONTEXT_COMPACTOR_CONFLICT: ${extension.path} returned a session_before_compact result; only observers that return undefined may coexist with the resident compactor`,
	);
}

export function assertResidentExtensions(
	extensions: readonly Extension[],
	customTools: readonly ToolDefinition[] = [],
): void {
	if (extensions.filter(isResident).length !== 1)
		throw new Error(
			`CONTEXT_RESIDENT_REQUIRED: exactly one ${CONTEXT_MEMORY_PATH} must be installed through createAgentSession`,
		);
	const resident = extensions.find(isResident)!;
	const protectedTools = new Set(resident.tools.keys());
	const otherTools = extensions
		.filter((extension) => !isResident(extension))
		.flatMap((extension) => [...extension.tools.keys()]);
	if ([...otherTools, ...customTools.map((tool) => tool.name)].some((name) => protectedTools.has(name)))
		throw new Error("CONTEXT_TOOL_CONFLICT: context_note and context_history belong to the resident extension");
}

export function claimMemorySession(session: SessionManager, owner: object): void {
	const previous = owners.get(session);
	if (previous && previous !== owner)
		throw new Error("CONTEXT_RUNTIME_CONFLICT: this SessionManager already belongs to another AgentSession");
	owners.set(session, owner);
}

export function releaseMemorySession(session: SessionManager, owner: object): void {
	if (owners.get(session) !== owner) return;
	owners.delete(session);
	try {
		revokeSessionHistory(session.getSessionId());
	} finally {
		session.close();
	}
}
