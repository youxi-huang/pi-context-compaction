import type { JsonValue } from "@earendil-works/chord";
import { afterEach, describe, expect, it } from "vitest";
import { assignJson } from "../src/harness/json.ts";

const probe = "pollutedByAssignJson";

afterEach(() => {
	delete (Object.prototype as Record<string, unknown>)[probe];
});

describe("assignJson prototype safety", () => {
	it("does not merge a parsed __proto__ key into Object.prototype", () => {
		const target: Record<string, JsonValue> = { message: {} };
		assignJson(target, "message", JSON.parse(`{"__proto__":{"${probe}":true},"text":"kept"}`) as JsonValue);
		expect(({} as Record<string, unknown>)[probe]).toBeUndefined();
		expect(target.message).toEqual({ text: "kept" });
		expect(Object.getPrototypeOf(target.message)).toBe(Object.prototype);
	});

	it("does not replace a container prototype through a top-level __proto__ key", () => {
		const target: Record<string, JsonValue> = {};
		assignJson(target, "__proto__", { [probe]: true });
		expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>)[probe]).toBeUndefined();
	});

	it("keeps ordinary keys, including constructor, as data", () => {
		const target: Record<string, JsonValue> = { details: { constructor: "old", stale: 1 } };
		assignJson(target, "details", { constructor: "new", nested: { value: 2 } });
		expect(target.details).toEqual({ constructor: "new", nested: { value: 2 } });
	});
});
