import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { pressureProfile } from "./context-memory-pressure-profile.mjs";

// Official DSH services and agent loop; only the provider is scripted. No credentials or network.
const { values } = parseArgs({ options: { "stock-root": { type: "string" }, "package-dir": { type: "string" }, "resume-root": { type: "string" } } });
assert(values["stock-root"] && values["package-dir"], "Required: --stock-root <official npm installation> --package-dir <built DSH adapter>");
const stock = resolve(values["stock-root"]);
const requireStock = createRequire(join(stock, "package.json"));
const lock = JSON.parse(readFileSync(join(stock, "node_modules/.package-lock.json"), "utf8"));
const hashes = new Map();
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function official(name) {
	const packageName = `@deepseek-ai/${name}`;
	const entry = requireStock.resolve(packageName);
	const provenance = lock.packages[`node_modules/${packageName}`];
	if (name.startsWith("dsh-")) assert.equal(provenance?.version, "0.2.1-rc.3");
	assert(provenance?.resolved?.startsWith(`https://registry.npmjs.org/${packageName}/-/`));
	assert.match(provenance.integrity, /^sha512-/);
	hashes.set(entry, sha(entry));
	return requireStock(packageName);
}
const { Context } = official("cordis");
const { SessionStore } = official("dsh-session");
const { SessionProjectionRegistry } = official("dsh-session-projection");
const { LlmRuntime, LlmAdapter, createUserMessage } = official("dsh-llm");
const { AgentRegistry } = official("dsh-agent");
const { AgentLoop } = official("dsh-agent-loop");
const { SystemPrompt } = official("dsh-system-prompt");
const { ToolRuntime, defineTool } = official("dsh-tools");
const { TokenMeter } = official("dsh-token-meter");
const { BasicCompactionEngine } = official("dsh-compaction-basic");
const Jsonl = official("dsh-session-persistence-jsonl");
const work = values["resume-root"] ?? mkdtempSync(join(tmpdir(), "slice-dsh-acceptance-"));
const candidate = join(work, "candidate");
if (!values["resume-root"]) {
	cpSync(resolve(values["package-dir"]), candidate, { recursive: true });
	symlinkSync(join(stock, "node_modules"), join(candidate, "node_modules"), "dir");
}
const slice = await import(pathToFileURL(join(candidate, "dist/index.js")).href);
const build = JSON.parse(readFileSync(join(candidate, "adapter-build.json"), "utf8"));
const bundleHash = sha(join(candidate, "dist/index.js"));
const profile = pressureProfile({ contextWindow: 200_000, maxOutputTokens: 32_000 });
const evidence = [];
const calls = [];
const checkpoints = [];
let failSummary = false;
let retrieve = false;
let burst = false;
let toolResult;
let reopenCalls = 0;
let contextWindow = 200_000;
class SyntheticAdapter extends LlmAdapter {
	async resolveModel(provider, model) {
		return { provider, id: model, name: "Synthetic", ...(contextWindow === undefined ? {} : { context: { contextWindow } }), defaultMaxTokens: 32_000 };
	}
	async *stream(options) {
		assert(calls.length < 100, "Synthetic provider budget exceeded");
		calls.push({ purpose: options.purpose, maxTokens: options.maxTokens });
		if (options.purpose === "compaction" && failSummary) throw new Error("Synthetic summary failure");
		const last = options.messages.at(-1);
		if (last?.role === "tool") toolResult = JSON.stringify(last);
		if ((retrieve || burst) && last?.role !== "tool" && options.purpose !== "compaction") {
			const name = burst ? "synthetic_burst" : "context_history";
			burst = false;
			yield { type: "tool-call-delta", index: 0, id: `synthetic-${calls.length}`, name, argumentsDelta: JSON.stringify(name === "context_history" ? { operation: "search", query: "original-port" } : {}) };
			yield { type: "finish", reason: { kind: "tool-calls" } };
		} else {
			yield { type: "text-delta", index: 0, text: "Synthetic summary or completed response." };
			yield { type: "finish", reason: { kind: "stop" } };
		}
	}
}
let ctx;
let handle;
const timer = setTimeout(() => { console.error("DSH acceptance deadline exceeded"); process.exit(1); }, 90_000);
async function mount(resume = false) {
	ctx = new Context();
	ctx.on("session/event", (_session, event) => { if (event.type === "compaction/summary") checkpoints.push(event); });
	await ctx.plugin(SessionStore).await();
	await ctx.plugin(SessionProjectionRegistry).await();
	await ctx.plugin(Jsonl, { root: join(work, "sessions"), compression: "none" }).await();
	await ctx.plugin(LlmRuntime).await();
	ctx.llm.registerAdapter(["synthetic"], new SyntheticAdapter());
	await ctx.plugin(AgentRegistry).await();
	await ctx.plugin(SystemPrompt, {}).await();
	await ctx.plugin(ToolRuntime).await();
	ctx.tools.register(defineTool({ name: "synthetic_burst", description: "Synthetic large tool response", parameters: {}, output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] }, execute: async () => "Synthetic burst ".repeat(20_000) }));
	await ctx.plugin(TokenMeter, {}).await();
	await ctx.plugin(BasicCompactionEngine, { ...profile.dsh.config, compactionRetries: 0 }).await();
	await ctx.plugin(AgentLoop, {}).await();
	await ctx.plugin(slice).await();
	const options = { [resume ? "resumeSessionId" : "sessionId"]: "synthetic-pressure", agentOptions: { provider: "synthetic", model: "scripted", maxTokens: 32_000 } };
	handle = await ctx.agents[resume ? "resume" : "create"](options);
}
async function unmount() {
	await handle?.dispose();
	handle = undefined;
	await ctx?.fiber.dispose();
	ctx = undefined;
}
async function prompt(text) {
	handle.agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
	await handle.agent.whenIdle();
}
const summaries = () => checkpoints;
const pressure = () => ctx.tokenMeter.measure(handle.agent.session).totalTokens;
async function run() {
	if (values["resume-root"]) {
		await mount(true);
		retrieve = true;
		await prompt("Retrieve synthetic original-port evidence.");
		assert(toolResult?.includes("4317"), "Built context_history did not recover originals after process restart");
		const stored = await ctx.sessionPersistence.open(handle.agent.session.id, "read");
		try { assert.equal((await stored.read()).events.filter((event) => event.type === "compaction/summary").length, 3); }
		finally { await stored.close(); }
		console.log(JSON.stringify({ providerCalls: calls.length }));
		return;
	}
	await mount();
	await prompt("Synthetic original-port is 4317. Do not deploy.");
	for (let cycle = 0; cycle < 3; cycle++) {
		// Drive full native turns with >500 kB of real text per cycle; use the official meter, not fake usage.
		while (pressure() < 135_000) {
			await prompt(`Synthetic old cycle ${cycle}. ${"filler ".repeat(10_000)}`);
			assert.equal(summaries().length, cycle, "Unexpected early native compaction");
		}
		await prompt(`Synthetic recent-${cycle}. ${"recent ".repeat(9000)}`);
		assert(pressure() >= profile.plan.triggerTokens, "Fixture did not reach native pressure");
		await prompt(`Finish synthetic recent-${cycle}.`);
		assert.equal(summaries().length, cycle + 1, "Native pre-step did not compact exactly once");
		assert(pressure() < profile.plan.triggerTokens);
		assert(JSON.stringify(handle.agent.session.deriveMessages()).includes(`recent-${cycle}`), "Recent raw text was lost");
		await prompt("Small synthetic follow-up.");
		assert.equal(summaries().length, cycle + 1, "Small follow-up immediately recompacted");
	}
	assert(calls.filter((call) => call.purpose === "compaction").every((call) => call.maxTokens === 8192));
	evidence.push("three native pre-step compactions with official token measurement, recent retention and no immediate recompaction");
	await unmount();
	const reopened = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--stock-root", stock, "--package-dir", candidate, "--resume-root", work], { env: { PATH: process.env.PATH, HOME: work }, encoding: "utf8", timeout: 30_000 });
	assert.equal(reopened.status, 0, `Cold process reopen failed: ${reopened.stderr}`);
	reopenCalls = JSON.parse(reopened.stdout).providerCalls;
	await mount(true);
	evidence.push("built plugin tool executes in the real agent loop and retrieves originals after cold process restart");
	while (pressure() < 100_000) await prompt(`Synthetic pre-burst. ${"filler ".repeat(10_000)}`);
	burst = true;
	await prompt("Produce one large synthetic tool result.");
	assert.equal(summaries().length, 4, "Large tool output did not trigger a native compaction between steps");
	assert(pressure() < profile.plan.triggerTokens);
	evidence.push("one 320 kB tool result triggers native compaction before the next model step");
	while (pressure() < 151_000) await prompt(`Synthetic failure source. ${"filler ".repeat(10_000)}`);
	failSummary = true;
	const before = summaries().length;
	const beforeCalls = calls.length;
	await prompt("Continue after synthetic summary failure.");
	assert.equal(summaries().length, before, "Failed native summary wrote a checkpoint");
	assert(calls.slice(beforeCalls).some((call) => call.purpose === "compaction"));
	assert(calls.slice(beforeCalls).some((call) => call.purpose !== "compaction"), "Expected native DSH failure policy to continue the turn");
	evidence.push("native DSH summary failure preserves history but continues the turn; Slice does not add fail-closed protection here");
	failSummary = false;
	await prompt("Retry native compaction.");
	assert.equal(summaries().length, before + 1);
	while (pressure() < 100_000) await prompt(`Synthetic before model switch. ${"filler ".repeat(10_000)}`);
	const beforeSwitch = summaries().length;
	contextWindow = 128_000;
	await prompt("Synthetic smaller-model route.");
	assert.equal(summaries().length, beforeSwitch + 1, "Native host did not recompute pressure for the smaller window");
	assert(pressure() < 128_000 - 32_000);
	evidence.push("native compaction recovers after writer failure; smaller capacity metadata resolves on the next route");
	contextWindow = undefined;
	const beforeUnknown = summaries().length;
	while (pressure() < 151_000) await prompt(`Synthetic unknown-capacity source. ${"filler ".repeat(10_000)}`);
	await prompt("Synthetic missing capacity metadata.");
	assert.equal(summaries().length, beforeUnknown, "Native host invented a capacity for pressure compaction");
	contextWindow = 200_000;
	await prompt("Synthetic restored capacity metadata.");
	assert.equal(summaries().length, beforeUnknown + 1);
	evidence.push("missing native capacity skips pressure compaction; restoring metadata resumes it");
	assert.equal(sha(join(candidate, "dist/index.js")), bundleHash);
	for (const [file, hash] of hashes) assert.equal(sha(file), hash, "Official service bytes changed");
	console.log(JSON.stringify({ host: "official npm DSH 0.2.1-rc.3 services and agent loop", providers: "synthetic adapter only; no network", sourceHash: build.sourceHash, providerCalls: calls.length + reopenCalls, summaryCalls: calls.filter((call) => call.purpose === "compaction").length, passed: evidence }, null, 2));
}
try {
	await run();
} finally {
	clearTimeout(timer);
	await unmount();
	if (!values["resume-root"]) rmSync(work, { recursive: true, force: true });
}
