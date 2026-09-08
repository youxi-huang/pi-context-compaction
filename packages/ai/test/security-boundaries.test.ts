import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { type AssistantMessageFrame, reduceAssistantMessageFrames } from "../src/utils/assistant-message-frame.ts";
import { isUrlFromDomain } from "../src/utils/url-domain.ts";

describe("endpoint domain matching", () => {
	it.each(["https://api.deepseek.com/v1", "https://DEEPSEEK.COM/v1", "https://api.deepseek.com.:443/v1"])(
		"recognizes the actual provider hostname: %s",
		(url) => {
			expect(isUrlFromDomain(url, "deepseek.com")).toBe(true);
		},
	);

	it.each([
		"https://deepseek.com.example.org/v1",
		"https://notdeepseek.com/v1",
		"https://example.org/deepseek.com/v1",
		"https://example.org/?provider=deepseek.com",
		"https://deepseek.com@example.org/v1",
		"https://example.org/#deepseek.com",
		"file:///deepseek.com",
		"not a URL",
	])("ignores domain-like text outside the provider hostname: %s", (url) => {
		expect(isUrlFromDomain(url, "deepseek.com")).toBe(false);
	});
});

describe("assistant frame prototype protection", () => {
	const partial: AssistantMessage = {
		role: "assistant",
		api: "openai-completions",
		provider: "test",
		model: "test",
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 0,
	};

	// CodeQL #34–38: every assignment goes through activeBlock's integer-index guard.
	it.each(["__proto__", "constructor", "prototype", "0", -1, 0.5, Number.NaN])(
		"rejects an untrusted content index %s before writing a block",
		(contentIndex) => {
			for (const type of ["text_end", "thinking_end", "toolcall_end"] as const) {
				const frame = {
					type,
					contentIndex,
					content: "payload",
					textSignature: "payload",
					thinkingSignature: "payload",
					redacted: true,
					id: "payload",
					name: "payload",
					arguments: {},
					thoughtSignature: "payload",
					namespace: "payload",
				} as unknown as AssistantMessageFrame;
				expect(() => reduceAssistantMessageFrames([{ type: "start", partial }, frame])).toThrow(
					"Invalid assistant message frame contentIndex",
				);
			}
			expect(Object.hasOwn(Object.prototype, "textSignature")).toBe(false);
			expect(Object.hasOwn(Object.prototype, "thoughtSignature")).toBe(false);
		},
	);
});
