import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

// Linux x64 acceptance on the unmodified npm binary. No inherited credentials or real provider.
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
	if (!["--stock-root", "--package-dir"].includes(args[i]) || !args[i + 1] || options[args[i]]) {
		throw new Error("Usage: node scripts/context-memory-opencode-acceptance.mjs --stock-root <npm installation> --package-dir <built adapter>");
	}
	options[args[i]] = resolve(args[i + 1]);
}
assert(options["--stock-root"] && options["--package-dir"], "Both paths are required");
assert(process.platform === "linux" && process.arch === "x64", "This acceptance fixture currently covers Linux x64 only");
const stock = options["--stock-root"];
const binaryPackage = "opencode-linux-x64-baseline";
const binary = join(stock, "node_modules", binaryPackage, "bin/opencode");
const lock = JSON.parse(readFileSync(join(stock, "node_modules/.package-lock.json"), "utf8"));
for (const name of ["opencode-ai", binaryPackage]) {
	const record = lock.packages[`node_modules/${name}`];
	assert.equal(record?.version, "1.19.4");
	assert.equal(record.resolved, `https://registry.npmjs.org/${name}/-/${name}-1.19.4.tgz`);
	assert.match(record.integrity, /^sha512-/);
	assert.equal(JSON.parse(readFileSync(join(stock, "node_modules", name, "package.json"), "utf8")).version, "1.19.4");
}
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const binaryHash = sha(binary);
const work = mkdtempSync(join(tmpdir(), "slice-opencode-acceptance-"));
const project = join(work, "project");
const candidate = join(work, "candidate");
mkdirSync(project);
cpSync(options["--package-dir"], candidate, { recursive: true });
assert.equal(JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")).name, "slice-opencode-preview");
for (const name of ["typebox", "zod"]) {
	const target = join(candidate, "node_modules", name);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(join(root, "node_modules", name), target, { recursive: true });
}
const build = JSON.parse(readFileSync(join(candidate, "adapter-build.json"), "utf8"));
const bundleHash = sha(join(candidate, "dist/index.js"));
const evidence = [];
let calls = 0;
let toolRequest;
let toolOutput;
const provider = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const body = JSON.parse(Buffer.concat(chunks).toString());
	if (++calls > 30) { response.writeHead(429); response.end(); return; }
	const last = body.messages?.at(-1);
	if (last?.role === "tool") toolOutput = last.content;
	const invoke = toolRequest && last?.role !== "tool" && body.tools?.some((tool) => tool.function?.name === "context_history");
	const message = invoke
		? { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: "context_history", arguments: JSON.stringify(toolRequest) } }] }
		: { role: "assistant", content: "Synthetic summary or response." };
	const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
	const common = { id: `synthetic_${calls}`, created: 1, model: "scripted" };
	if (!body.stream) {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ ...common, object: "chat.completion", choices: [{ index: 0, message, finish_reason: invoke ? "tool_calls" : "stop" }], usage }));
		return;
	}
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const chunk of [
		{ choices: [{ index: 0, delta: message, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: invoke ? "tool_calls" : "stop" }], usage },
	]) response.write(`data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", ...chunk })}\n\n`);
	response.end("data: [DONE]\n\n");
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const config = {
	autoupdate: false, share: "disabled", enabled_providers: ["synthetic"], model: "synthetic/scripted", small_model: "synthetic/scripted",
	plugin: [pathToFileURL(join(candidate, "dist/index.js")).href],
	provider: { synthetic: { npm: "@ai-sdk/openai-compatible", name: "Synthetic", options: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "synthetic" }, models: { scripted: { name: "Synthetic", limit: { context: 128000, output: 4000 } } } } },
	permission: { "*": "deny", context_history: "allow" }, compaction: { auto: false },
};
const configPath = join(work, "opencode.json");
const env = {
	PATH: process.env.PATH, HOME: work, CI: "1",
	XDG_DATA_HOME: join(work, "data"), XDG_CONFIG_HOME: join(work, "config"), XDG_CACHE_HOME: join(work, "cache"), XDG_STATE_HOME: join(work, "state"),
	OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOCOMPACT: "1",
	OPENCODE_DISABLE_FFF: "1", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
	// This local plugin does not need the host's optional registry bootstrap.
	npm_config_offline: "true", npm_config_fetch_retries: "0",
};
let child;
let logs = "";
const deadline = AbortSignal.timeout(240_000);
async function start() {
	writeFileSync(configPath, JSON.stringify(config));
	logs = "";
	child = spawn(binary, ["serve", "--port", "0", "--hostname", "127.0.0.1"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.on("data", (chunk) => { logs += chunk; });
	child.stderr.on("data", (chunk) => { logs += chunk; });
	for (let i = 0; i < 200; i++) {
		const address = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
		if (address) return createOpencodeClient({ baseUrl: address, directory: project });
		assert.equal(child.exitCode, null, "Official host exited before startup");
		await delay(100, undefined, { signal: deadline });
	}
	throw new Error("Official host startup timed out");
}
async function stop() {
	if (!child || child.exitCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
	try { await exited; } finally { clearTimeout(timer); }
}
try {
	const version = spawnSync(binary, ["--version"], { env, encoding: "utf8", timeout: 5000 });
	assert.equal(version.status, 0);
	assert.equal(version.stdout.trim(), "1.19.4");
	let client = await start();
	const { data: session } = await client.session.create({ body: { title: "Synthetic Slice acceptance" }, throwOnError: true, signal: deadline });
	const scope = { path: { id: session.id }, throwOnError: true, signal: deadline };
	const model = { providerID: "synthetic", modelID: "scripted" };
	const { data: original } = await client.session.prompt({ ...scope, body: { noReply: true, model, parts: [{ type: "text", text: `Synthetic original-port is 4317. ${"Synthetic filler. ".repeat(1500)}` }] } });
	const originalPart = original.parts.find((part) => part.type === "text");
	assert(originalPart);
	for (let i = 0; i < 2; i++) {
		await client.session.prompt({ ...scope, body: { model, parts: [{ type: "text", text: `Synthetic completed turn ${i}` }] } });
		await client.session.summarize({ ...scope, body: model });
	}
	const { data: before } = await client.session.messages(scope);
	assert.equal(before.filter(({ info }) => info.role === "assistant" && info.summary === true && !info.error).length, 2);
	assert(before.some(({ parts }) => parts.some((part) => part.id === originalPart.id && part.text === originalPart.text)));
	evidence.push("two native compactions preserve the original part");
	await stop();
	client = await start();
	async function invoke(request) {
		toolRequest = request;
		toolOutput = undefined;
		const { data } = await client.session.prompt({ ...scope, body: { model, parts: [{ type: "text", text: "Retrieve the earlier synthetic evidence." }] } });
		assert(!data.info.error, "Primary request failed");
		assert.equal(typeof toolOutput, "string", "Built plugin tool did not run");
		return JSON.parse(toolOutput);
	}
	const searched = await invoke({ operation: "search", query: "original-port" });
	assert(searched.entries.some((entry) => entry.entryId === originalPart.id && entry.text.includes("4317")));
	evidence.push("built plugin retrieves original native IDs after cold process restart");
	const request = { operation: "read", entryId: originalPart.id };
	const first = await invoke(request);
	assert(first.cursor);
	const next = await invoke({ ...request, cursor: first.cursor });
	assert.equal(next.entries[0].offset, first.entries[0].text.length);
	assert.equal(next.entries[0].text, originalPart.text.slice(next.entries[0].offset, next.entries[0].offset + next.entries[0].text.length));
	evidence.push("bounded read continues across appended turns using the original cursor");
	await stop();
	config.plugin = [];
	client = await start();
	const { data: retained } = await client.session.messages(scope);
	assert(retained.some(({ parts }) => parts.some((part) => part.id === originalPart.id)));
	evidence.push("removing the plugin leaves original native history readable");
	assert.equal(sha(binary), binaryHash);
	assert.equal(sha(join(candidate, "dist/index.js")), bundleHash);
	console.log(JSON.stringify({ host: "official npm OpenCode 1.19.4", platform: "linux-x64", providers: "loopback synthetic only", sourceHash: build.sourceHash, binaryHash, providerCalls: calls, passed: evidence }, null, 2));
} finally {
	await stop();
	provider.closeAllConnections();
	await new Promise((done) => provider.close(done));
	rmSync(work, { recursive: true, force: true });
}
