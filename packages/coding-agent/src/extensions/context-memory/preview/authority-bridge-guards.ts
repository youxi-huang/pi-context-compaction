import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AuthorityBridgeAction } from "./authority-bridge.ts";
import type { PreviewSession } from "./contracts.ts";

/** A bridge-only reader authorizes legacy sessions, never an authority projection. */
export interface AuthorityBridgeReader {
	assertLegacy(session: PreviewSession, action: AuthorityBridgeAction): void;
}

const notice =
	"context-memory authority: session ownership is unresolved or unsupported by this reader. Use a compatible authority reader before continuing or recovering.";

/**
 * Slash commands run before input hooks. Their mutating entry points, including
 * ordinary recovery, must call this before any legacy controller/store action.
 */
export function assertLegacyAuthorityOperation(
	reader: AuthorityBridgeReader,
	ctx: ExtensionContext,
	action: AuthorityBridgeAction,
): void {
	reader.assertLegacy(ctx.sessionManager, action);
}

function allowed(
	reader: AuthorityBridgeReader,
	ctx: ExtensionContext,
	action: AuthorityBridgeAction,
	activeRequest = false,
): boolean {
	try {
		assertLegacyAuthorityOperation(reader, ctx, action);
		return true;
	} catch {
		if (activeRequest) ctx.abort();
		try {
			ctx.ui.notify(notice, "error");
		} catch {
			// A notification is observational, never the cancellation mechanism.
		}
		return false;
	}
}

/**
 * Offline prototype only: production does not call this installer or enroll
 * authority sessions. Register it before any enabled:false return when integrating.
 * Unsupported ownership refuses with each public event's explicit mechanism;
 * swallowed exceptions and before_agent_start aborts are insufficient.
 * Cache-warming overrides are last-wins; require a reviewed handler order.
 * This installer does not gate independent writer/tool/command implementations;
 * those must call assertLegacyAuthorityOperation before doing any work.
 */
export function installAuthorityBridgeGuards(pi: ExtensionAPI, reader: AuthorityBridgeReader): void {
	pi.on("input", (_event, ctx) => {
		if (!allowed(reader, ctx, "dispatch")) return { action: "handled" };
		return undefined;
	});
	pi.on("cache_warming_decision", (_event, ctx) => {
		if (!allowed(reader, ctx, "dispatch")) return { action: "stop" };
		return undefined;
	});
	pi.on("context", (_event, ctx) => {
		if (allowed(reader, ctx, "dispatch", true)) return undefined;
		return { messages: [] };
	});
	pi.on("context_with_system", (event, ctx) => {
		if (allowed(reader, ctx, "dispatch", true)) return undefined;
		// Keep stock Pi's leading prompt/tool invariant while the active run aborts.
		return { messages: event.messages[0]?.role === "system" ? [event.messages[0]] : [] };
	});
	pi.on("before_provider_request", (_event, ctx) => {
		allowed(reader, ctx, "dispatch", true);
	});
	pi.on("session_before_compact", (_event, ctx) => {
		if (!allowed(reader, ctx, "compact")) return { cancel: true };
		return undefined;
	});
	pi.on("session_before_tree", (_event, ctx) => {
		if (!allowed(reader, ctx, "navigate")) return { cancel: true };
		return undefined;
	});
	pi.on("session_before_fork", (_event, ctx) => {
		if (!allowed(reader, ctx, "fork")) return { cancel: true };
		return undefined;
	});
}
