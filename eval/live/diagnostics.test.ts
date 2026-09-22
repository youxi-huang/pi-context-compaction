import { describe, expect, it } from "vitest";
import { seedQuota } from "./diagnose.ts";
import { ResponseDiagnostics, redactor, transportErrorChain } from "./diagnostics.ts";
import { environmentSnapshot, networkSelfCheck } from "./environment.ts";
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

describe("transport and environment diagnostics", () => {
	it("records nested and aggregate exception chains without credential echoes", () => {
		const cause = Object.assign(new Error("connect denied https://name:secret@proxy.test"), {
			code: "EPERM",
			errno: -1,
		});
		const error = new TypeError("fetch failed private-access", { cause: new AggregateError([cause], "all failed") });
		const chain = transportErrorChain(error, redactor(["private-access"]));
		expect(chain.name).toBe("TypeError");
		expect(chain.cause?.errors?.[0]).toMatchObject({ code: "EPERM", errno: -1 });
		expect(chain.stackFirstLine).toContain("TypeError");
		expect(JSON.stringify(chain)).not.toContain("private-access");
		expect(JSON.stringify(chain)).not.toContain("name:secret");
		Object.assign(cause, { cause });
		expect(transportErrorChain(cause).cause?.circular).toBe(true);
	});
	it("records only guard booleans and proxy variable names", () => {
		const snapshot = environmentSnapshot(
			{ PI_OFFLINE: "1", NODE_OPTIONS: "--import=/private/deny-network.mjs", HTTPS_PROXY: "secret-proxy-url" },
			[],
			async function denied() {
				throw new Error("EVAL_NETWORK_FORBIDDEN");
			},
		);
		expect(snapshot.guards).toMatchObject({ "deny-network": true, PI_OFFLINE: true, "named-fetch-guard": true });
		expect(snapshot.proxyEnvironmentVariables).toEqual(["HTTPS_PROXY"]);
		expect(JSON.stringify(snapshot)).not.toContain("secret-proxy-url");
		expect(JSON.stringify(snapshot)).not.toContain("/private/");
	});
	it("performs exactly one DNS and TCP probe without HTTP", async () => {
		const calls: unknown[] = [];
		const result = await networkSelfCheck({
			lookup: async (host) => {
				calls.push(host);
				return [
					{ address: "192.0.2.1", family: 4 },
					{ address: "192.0.2.2", family: 4 },
				];
			},
			connect: async (...args) => {
				calls.push(args);
			},
		});
		expect(result.ok).toBe(true);
		expect(calls).toEqual(["chatgpt.com", ["192.0.2.1", 4, 443]]);
		expect(result.providerRequests).toBe(0);
	});
	it("stops on DNS or TCP failure without retries", async () => {
		let tcpCalls = 0;
		const connect = async () => {
			tcpCalls++;
			throw Object.assign(new Error("connect denied"), { code: "EPERM" });
		};
		const dnsFailure = await networkSelfCheck({
			lookup: async () => {
				throw Object.assign(new Error("DNS failed"), { code: "ENOTFOUND" });
			},
			connect,
		});
		expect(dnsFailure.ok).toBe(false);
		expect(tcpCalls).toBe(0);
		const tcpFailure = await networkSelfCheck({ lookup: async () => [{ address: "192.0.2.1", family: 4 }], connect });
		expect(tcpFailure.ok).toBe(false);
		expect(tcpCalls).toBe(1);
		expect(JSON.stringify(tcpFailure)).toContain("EPERM");
	});
	it("retains both prior unknown reservations when admitting the third attempt", () => {
		const ledger = new Ledger(),
			q = ledger.group("global", { calls: 1692, input: 39288000, output: 4490880, milliseconds: 1000 });
		seedQuota(q, {
			...q.snapshot(),
			calls: 2,
			sent: 2,
			inputProxy: 69312,
			reservedInput: 108064,
			reservedOutput: 16000,
		});
		ledger.sent(ledger.admit([q], 34656, 8000, 160000));
		expect(q.snapshot()).toMatchObject({ calls: 3, sent: 3, reservedInput: 162096, reservedOutput: 24000 });
	});
});
