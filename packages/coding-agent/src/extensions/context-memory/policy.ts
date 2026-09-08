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

export function assertExclusiveCompaction(extensions: readonly Extension[]): void {
	const resident = extensions.find(isResident);
	if (!resident?.handlers.get("session_before_compact")?.length) return;
	const other = extensions.filter(
		(extension) => !isResident(extension) && extension.handlers.get("session_before_compact")?.length,
	);
	if (other.length)
		throw new Error(
			`CONTEXT_COMPACTOR_CONFLICT: disable competing session_before_compact handlers: ${other.map((extension) => extension.path).join(", ")}`,
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
	assertExclusiveCompaction(extensions);
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
