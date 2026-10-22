import { describe, expect, it } from "vitest";
import { errorCode } from "../src/events.ts";
import { assertToolPairs } from "../src/guards.ts";
import type { RecordMessage } from "../src/records.ts";

const calls: RecordMessage = {
	role: "assistant",
	content: [
		{ type: "toolCall", id: "c1" },
		{ type: "toolCall", id: "c2" },
	],
};
const result = (toolCallId: string): RecordMessage => ({ role: "toolResult", toolCallId, content: [] });

describe("structural tool-pair check", () => {
	it("allows a complete parallel batch with results in either order", () => {
		expect(() =>
			assertToolPairs([calls, result("c2"), result("c1"), { role: "user", content: "Continue." }]),
		).not.toThrow();
	});

	it.each(
		[
			[calls, result("c1"), { role: "assistant", content: [] }],
			[result("unknown")],
			[calls, { role: "user", content: "Continue." }],
			[calls, result("c1")],
		].map((messages) => ({ messages })),
	)("refuses a split or unmatched batch %# by class", ({ messages }) => {
		try {
			assertToolPairs(messages);
			throw new Error("Expected a tool boundary refusal");
		} catch (error) {
			expect(errorCode(error instanceof Error ? error.message : undefined)).toBe("CONTEXT_TOOL_BOUNDARY");
		}
	});
});
