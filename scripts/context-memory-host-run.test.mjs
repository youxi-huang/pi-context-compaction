import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
// Importing the script starts no run: only its helpers are read here.
import { answers, hostMessages, MESSAGES, parseOptions, QUESTIONNAIRE_MARK, questionnaire, startLoopback } from "./context-memory-host-run.mjs";

const records = readFileSync(fileURLToPath(new URL("../eval/preview/fixtures/P5/records.jsonl", import.meta.url)), "utf8")
	.trim()
	.split("\n")
	.slice(1)
	.map((line) => JSON.parse(line));
const required = ["--host", "dsh", "--route", "272k", "--provider", "loopback", "--host-root", "h", "--package-dir", "p", "--output-dir", "o"];

test("options are checked before any host starts, and a provider run needs all three limits", () => {
	assert.equal(parseOptions(required).limits.requests, 80);
	assert.throws(() => parseOptions(required.slice(2)), /Missing --host/);
	assert.throws(() => parseOptions([...required.slice(0, 3), "128k", ...required.slice(4)]), /--route must be 200k or 272k/);
	assert.throws(() => parseOptions([...required.slice(0, 5), "deepseek", ...required.slice(6)]), /--provider must be loopback or openai/);
	const openai = [...required.slice(0, 5), "openai", ...required.slice(6)];
	assert.throws(() => parseOptions(openai), /Missing --max-requests/);
	assert.throws(() => parseOptions([...openai, "--max-requests", "60", "--max-minutes", "100"]), /Missing --max-cost-usd/);
	assert.deepEqual(parseOptions([...openai, "--max-requests", "60", "--max-minutes", "100", "--max-cost-usd", "1.2"]).limits, { requests: 60, minutes: 100, costUsd: 1.2 });
	assert.throws(() => parseOptions([...openai, "--max-requests", "0", "--max-minutes", "1", "--max-cost-usd", "1"]), /--max-requests must be positive/);
	assert.throws(() => parseOptions(["--host", "opencode", ...required.slice(2), "--summary-tokens", "16384"]), /applies only to --host dsh/);
	assert.equal(parseOptions([...required, "--summary-tokens", "16384"]).summaryTokens, 16384);
});

test("the host messages carry every P5 user instruction and tool output once, in order, without assistant text", () => {
	const messages = hostMessages();
	assert.equal(messages.length, MESSAGES.length);
	const sent = messages.flatMap((message) => message.records);
	const expected = records.filter((record) => record.message.role !== "assistant").map((record) => record.id);
	assert.deepEqual(sent, expected);
	assert.match(messages[0].text, /^For this whole session I run every command/);
	for (const [index, message] of messages.entries()) {
		const first = records.find((record) => record.id === message.records[0]);
		if (first.message.role === "user") assert.equal(message.turn, first.id);
		else assert.match(message.text, /^More of what came back:\n\n/);
		const next = messages[index + 1];
		const continued = next && records.find((record) => record.id === next.records[0]).message.role !== "user";
		assert.equal(message.text.endsWith("(More output follows in my next message.)"), Boolean(continued), `message ${index}`);
		assert(Buffer.byteLength(message.text) < 70_000, `message ${index}`);
	}
	// The planted values travel inside the pasted outputs.
	assert.match(messages[3].text, /E-7310 checksum mismatch on shard 17/);
});

test("the questionnaire asks only what the delivered records hold, with values as they stand after them", () => {
	const through = (count) => new Set(MESSAGES.slice(0, count).flat().map((n) => `p5-${String(n).padStart(5, "0")}`));
	const all = questionnaire(through(MESSAGES.length));
	assert.equal(all.probes.length, 15);
	const expected = Object.fromEntries(all.probes.map((probe) => [probe.id, probe.expected]));
	assert.deepEqual(expected["batch-now"], { type: "number", value: 700 });
	assert.deepEqual(expected["batch-before"], { type: "number", value: 650 });
	assert.deepEqual(expected["batch-count"], { type: "number", value: 3 });
	assert.deepEqual(expected.window, { type: "text", accept: ["Saturday"] });
	assert.deepEqual(expected.absent, { type: "unknown" });
	assert(all.text.startsWith(QUESTIONNAIRE_MARK));
	assert.match(all.text, /^15\. Which CDN fronts the ledger API\?$/m);

	const early = questionnaire(through(13));
	const ids = early.probes.map((probe) => probe.id);
	assert.deepEqual(ids, ["batch-now", "batch-before", "batch-count", "window", "error", "shard", "snapshot", "authority", "lag", "absent"]);
	assert.deepEqual(early.probes[0].expected, { type: "number", value: 800 });
	assert.deepEqual(early.probes[1].expected, { type: "number", value: 500 });
	assert.deepEqual(early.probes[3].expected, { type: "text", accept: ["Sunday"] });
});

test("answers are read from one JSON object keyed by question number, fenced or not", () => {
	assert.deepEqual(answers('```json\n{"1":{"status":"answer","value":650},"3":{"status":"unknown"}}\n```', 3), [
		{ status: "answer", value: 650 },
		undefined,
		{ status: "unknown" },
	]);
	assert.deepEqual(answers('Here you go: {"1":{"status":"answer","value":"E-7310"}} done', 1), [{ status: "answer", value: "E-7310" }]);
	assert.deepEqual(answers("no JSON here", 2), [undefined, undefined]);
	assert.deepEqual(answers(null, 1), [undefined]);
});

async function stream(url, body) {
	const response = await fetch(`${url}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const events = (await response.text())
		.split("\n\n")
		.filter(Boolean)
		.map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
	return { completed: events.at(-1), done: events.find((event) => event.type === "response.output_item.done").item };
}

test("the loopback stand-in answers both request shapes, searches history once for the questionnaire and caches a continued prefix", async (t) => {
	const loopback = await startLoopback();
	t.after(() => loopback.server.close());
	const question = { role: "user", content: [{ type: "input_text", text: `${QUESTIONNAIRE_MARK} Reply.\n\n1. One?\n2. Two?` }] };
	const history = { type: "function", name: "context_history", parameters: {} };
	// OpenCode's shape: tools in the body.
	const first = await stream(loopback.url, { model: "gpt-6-luna", prompt_cache_key: "s", tools: [history], input: [question] });
	assert.equal(first.done.type, "function_call");
	assert.equal(first.done.name, "context_history");
	assert.equal(first.completed.response.usage.input_tokens_details.cached_tokens, 0);
	// pi-ai's shape for Luna: tools in an additional_tools item, effort in a configuration_update.
	const answered = await stream(loopback.url, {
		model: "gpt-6-luna",
		prompt_cache_key: "s",
		input: [
			{ type: "additional_tools", role: "developer", tools: [history] },
			question,
			{ type: "configuration_update", reasoning: { effort: "max" } },
			{ type: "function_call", call_id: "c", name: "context_history", arguments: "{}" },
			{ type: "function_call_output", call_id: "c", output: "{}" },
		],
	});
	assert.deepEqual(JSON.parse(answered.done.content[0].text), { 1: { status: "unknown" }, 2: { status: "unknown" } });
	const long = { role: "user", content: [{ type: "input_text", text: "x".repeat(3_000) }] };
	await stream(loopback.url, { model: "gpt-6-luna", prompt_cache_key: "k", input: [long] });
	const next = await stream(loopback.url, { model: "gpt-6-luna", prompt_cache_key: "k", input: [long, { role: "user", content: [{ type: "input_text", text: "Status?" }] }] });
	assert.equal(next.done.content[0].text, "Noted.");
	assert.equal(next.completed.response.usage.input_tokens_details.cached_tokens, 896);
	const summary = await stream(loopback.url, { model: "gpt-6-luna", input: [long, { role: "user", content: "Summarize the conversation so far." }] });
	assert.match(summary.done.content[0].text, /^## Summary/);
	assert.equal(loopback.calls(), 5);
});
