import { describe, expect, it } from "vitest";
import { seedQuota } from "./diagnose.ts";
import { ResponseDiagnostics, redactor } from "./diagnostics.ts";
import { Ledger } from "./ledger.ts";

describe("bounded response diagnostics", () => {
	it("redacts credentials and Authorization values in JSON, text, and encoded echoes", () => {
		const secret = "secret/sensitive+access-token",
			scrub = redactor([secret]);
		const cases = [
			JSON.stringify({
				Authorization: `Bearer ${secret}`,
				refresh_token: "private-refresh",
				nested: { apiKey: "private-key" },
				error: `echo ${secret}`,
			}),
			`Authorization: Bearer ${secret}\nHTTP 400 unsupported max_output_tokens`,
			encodeURIComponent(secret),
			Buffer.from(secret).toString("base64"),
			JSON.stringify({ credentials: { refresh: ["private-refresh"] } }),
		];
		for (const text of cases) {
			const clean = scrub(text);
			for (const sensitive of [
				secret,
				"private-refresh",
				"private-key",
				encodeURIComponent(secret),
				Buffer.from(secret).toString("base64"),
			])
				expect(clean).not.toContain(sensitive);
		}
		expect(scrub(cases[1])).toContain("unsupported max_output_tokens");
	});
	it("records an HTTP error safely and keeps its status for attribution", async () => {
		const d = new ResponseDiagnostics(["private-access"]);
		await d.response(
			new Response(
				JSON.stringify({
					error: { message: "Unsupported parameter max_output_tokens" },
					Authorization: "Bearer private-access",
				}),
				{ status: 400, headers: { "content-type": "application/json", Authorization: "private-access" } },
			),
		);
		expect(d.snapshot()).toMatchObject({ httpStatus: 400, terminalEventTypes: [], requestHeadersPersisted: false });
		expect(d.errorBody).toContain("Unsupported parameter");
		expect(JSON.stringify(d.snapshot())).not.toContain("private-access");
	});
	it("observes multiline terminal data independently without changing the accounting parser", () => {
		const d = new ResponseDiagnostics([]);
		for (const line of [
			'data: {"type":"response.completed",',
			'data: "response":{"usage":{"input_tokens":12,"output_tokens":8}}}',
			"",
		])
			d.line(line);
		expect(d.terminalTypes).toEqual(["response.completed"]);
		expect(d.usageCandidates).toEqual([
			{ eventType: "response.completed", path: "response.usage", value: { input_tokens: 12, output_tokens: 8 } },
		]);
	});
	it("captures SSE errors and bounds overlarge error bodies without partial-secret leakage", async () => {
		const d = new ResponseDiagnostics(["private-access"]);
		d.line('data: {"type":"error","error":{"message":"Denied","Authorization":"Bearer private-access"}}');
		d.line("");
		expect(d.terminalTypes).toEqual(["error"]);
		expect(d.errorBody).toContain("Denied");
		expect(d.errorBody).not.toContain("private-access");
		await d.response(new Response("x".repeat(66000) + "private-access", { status: 500 }));
		expect(d.errorBody).toBe("[error body over 65536 bytes omitted]");
	});
	it("carries prior unknown reservations and call counts into the one-request diagnostic", () => {
		const ledger = new Ledger(),
			q = ledger.group("global", { calls: 1692, input: 39288000, output: 4490880, milliseconds: 1000 });
		seedQuota(q, {
			...q.snapshot(),
			calls: 1,
			sent: 1,
			inputProxy: 34656,
			reservedInput: 54032,
			reservedOutput: 8000,
		});
		const r = ledger.admit([q], 34656, 8000, 160000);
		ledger.sent(r);
		expect(q.calls).toBe(2);
		expect(q.sent).toBe(2);
		expect(q.reservedInput).toBe(108064);
		expect(q.reservedOutput).toBe(16000);
		expect(() => ledger.settle(r, null, null)).toThrow("EVAL_USAGE_UNAVAILABLE");
		expect(q.reservedOutput).toBe(16000);
	});
});
