import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AuthorityBridgeAction } from "../src/extensions/context-memory/preview/authority-bridge.ts";
import {
	type AuthorityBridgeReader,
	assertLegacyAuthorityOperation,
	installAuthorityBridgeGuards,
} from "../src/extensions/context-memory/preview/authority-bridge-guards.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function fixture() {
	const handlers = new Map<string, Handler>();
	const on = vi.fn((event: string, handler: Handler) => handlers.set(event, handler));
	const pi = { on } as unknown as ExtensionAPI;
	const abort = vi.fn();
	const notify = vi.fn();
	const sessionManager = { getSessionId: () => "synthetic-authority-session" };
	const ctx = { sessionManager, abort, hasUI: false, ui: { notify } } as unknown as ExtensionContext;
	const assertLegacy = vi.fn<AuthorityBridgeReader["assertLegacy"]>();
	const reader = { assertLegacy };
	installAuthorityBridgeGuards(pi, reader);
	const emit = (event: string, value: unknown = {}) => {
		const handler = handlers.get(event);
		if (!handler) throw new Error("Missing bridge hook");
		return handler(value, ctx);
	};
	return { abort, notify, ctx, assertLegacy, reader, emit, handlers };
}

describe("authority bridge prototype uses explicit stock event refusal", () => {
	it("leaves each legacy path to its existing owner after a fresh check", () => {
		const f = fixture();
		for (const event of f.handlers.keys()) expect(f.emit(event)).toBeUndefined();
		expect(f.assertLegacy).toHaveBeenCalledTimes(8);
		expect(f.abort).not.toHaveBeenCalled();
		expect(f.notify).not.toHaveBeenCalled();
	});

	it.each(["pending", "unsealed", "active", "unsupported", "tampered"])(
		"consumes input and cancels independent generation/navigation paths for %s ownership",
		(state) => {
			const f = fixture();
			f.assertLegacy.mockImplementation(() => {
				throw new Error(state);
			});
			expect(f.emit("input", { source: "interactive", text: "synthetic input" })).toEqual({ action: "handled" });
			expect(f.emit("cache_warming_decision")).toEqual({ action: "stop" });
			for (const reason of ["manual", "threshold", "overflow"]) {
				expect(f.emit("session_before_compact", { reason })).toEqual({ cancel: true });
			}
			expect(f.emit("session_before_tree", { preparation: { userWantsSummary: true } })).toEqual({ cancel: true });
			for (const position of ["before", "at"]) {
				expect(f.emit("session_before_fork", { position })).toEqual({ cancel: true });
			}
			expect(f.abort).not.toHaveBeenCalled();
		},
	);

	it("independently aborts all three active request hooks and quarantines context messages", () => {
		const f = fixture();
		f.assertLegacy.mockImplementation(() => {
			throw new Error("Owned session");
		});
		const messages = [{ role: "user", content: "Synthetic source data" }];
		expect(f.emit("context", { messages })).toEqual({ messages: [] });
		const leading = { role: "system", content: "Synthetic host prompt", tools: [] };
		expect(f.emit("context_with_system", { messages: [leading, ...messages] })).toEqual({ messages: [leading] });
		expect(f.emit("before_provider_request", { payload: { messages } })).toBeUndefined();
		expect(f.abort).toHaveBeenCalledTimes(3);
		expect(f.abort.mock.invocationCallOrder[0]).toBeLessThan(f.notify.mock.invocationCallOrder[0]);
		expect(messages).toHaveLength(1);
		expect(f.assertLegacy).toHaveBeenCalledTimes(3);
	});

	it("does not reuse a legacy decision after ownership or request context changes", () => {
		const f = fixture();
		expect(f.emit("context")).toBeUndefined();
		f.assertLegacy.mockImplementation(() => {
			throw new Error("Enrollment started between hooks");
		});
		expect(f.emit("context_with_system", { messages: [] })).toEqual({ messages: [] });
		expect(f.emit("before_provider_request")).toBeUndefined();
		expect(f.assertLegacy).toHaveBeenCalledTimes(3);
		expect(f.abort).toHaveBeenCalledTimes(2);
	});

	it("fails closed on inspection and notification errors without exposing their content", () => {
		const f = fixture();
		f.assertLegacy.mockImplementation(() => {
			throw new Error("Synthetic private receipt text");
		});
		f.notify.mockImplementation(() => {
			throw new Error("Notification unavailable");
		});
		expect(f.emit("input", { source: "rpc" })).toEqual({ action: "handled" });
		expect(f.emit("session_before_compact")).toEqual({ cancel: true });
		expect(f.emit("context")).toEqual({ messages: [] });
		expect(f.abort).toHaveBeenCalledOnce();
		expect(JSON.stringify(f.notify.mock.calls)).not.toContain("private receipt");
	});

	it("uses the same refusal for RPC, extension, transformed and interactive inputs", () => {
		const f = fixture();
		f.assertLegacy.mockImplementation(() => {
			throw new Error("Owned session");
		});
		for (const source of ["interactive", "rpc", "extension"]) {
			expect(f.emit("input", { source, text: "Synthetic directive", images: [] })).toEqual({ action: "handled" });
		}
	});

	it.each<AuthorityBridgeAction>(["recover", "retry", "dispatch"])(
		"refuses %s before any legacy command, store or tool mutation",
		(action) => {
			const f = fixture();
			f.assertLegacy.mockImplementation(() => {
				throw new Error("Unsupported authority ownership");
			});
			const legacyMutation = vi.fn();
			expect(() => {
				assertLegacyAuthorityOperation(f.reader, f.ctx, action);
				legacyMutation();
			}).toThrow("Unsupported authority ownership");
			expect(legacyMutation).not.toHaveBeenCalled();
			expect(f.assertLegacy).toHaveBeenCalledWith(f.ctx.sessionManager, action);
		},
	);
});
