// Cloned from the bounded-error-code assertions of packages/coding-agent/test/context-memory.test.ts
// ("the event log can be disabled and errors are reduced to bounded codes"), retargeted at the core
// copy. The resident tests keep running against the resident copy untouched; this file imports
// nothing from Pi. The `EventLog` quota, rotation and disable coverage stays host-side with the
// file IO.
import { describe, expect, it } from "vitest";
import { errorCode, PROJECT_CODES } from "../src/events.ts";

describe("compaction core: bounded error classes", () => {
	it("reduces any error to a class from the closed set", () => {
		expect(errorCode("Compaction failed: CONTEXT_SOURCE_CHANGED: discard the candidate")).toBe(
			"CONTEXT_SOURCE_CHANGED",
		);
		expect(errorCode("HISTORY_SCOPE_DENIED")).toBe("HISTORY_SCOPE_DENIED");
		expect(errorCode("This operation was aborted")).toBe("ABORTED");
		expect(errorCode(undefined, true)).toBe("ABORTED");
		expect(errorCode("request failed with status 429: rate limited")).toBe("HTTP_429");
		expect(errorCode("connect ECONNRESET 10.0.0.1:443")).toBe("ECONNRESET");
		expect(errorCode("Something at /Users/name/secret.txt went wrong")).toBe("UNKNOWN");
		// Uppercase tokens echoed from untrusted text are not classes.
		expect(errorCode("user said: HISTORY_OF_MY_MEDICAL_CONDITION")).toBe("UNKNOWN");
		expect(errorCode("CONTEXT_SOMETHING_NEW: not a known class")).toBe("UNKNOWN");
		expect(errorCode("EVERYTHING_BROKE")).toBe("UNKNOWN");
	});

	it("PROJECT_CODES is the closed set the specification's conformance matches on", () => {
		for (const stable of [
			"CONTEXT_BLOCKED",
			"CONTEXT_NOTE_INVALID",
			"CONTEXT_NOTE_SCOPE",
			"CONTEXT_NOTE_QUOTE",
			"CONTEXT_NOTE_BUDGET",
			"CONTEXT_SOURCE_CHANGED",
			"CONTEXT_CONTINUATION_MISSING",
			"CONTEXT_TOOL_BOUNDARY",
			"HISTORY_CURSOR_INVALID",
			"HISTORY_QUERY_INVALID",
			"HISTORY_SCOPE_DENIED",
		])
			expect(PROJECT_CODES.has(stable)).toBe(true);
		for (const code of PROJECT_CODES) expect(code).toMatch(/^(?:CONTEXT|HISTORY)_[A-Z_]+$/);
	});
});
