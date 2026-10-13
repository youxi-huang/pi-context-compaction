import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectOfficialPi } from "./context-memory-preview-stock-install.mjs";

// Bounded A/B comparison of the preview's compaction paths on official Pi: sync (both switches off), A
// (previewPreparation) and B (previewWorkNotes). Every arm runs the same scripted conversation and settings
// against a loopback provider. Synthetic only: it never contacts a model service, and its prices, latency
// and recovery probes measure mechanics, not provider quality, cache behaviour or real cost.

const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
function argument(name, fallback) {
	const index = args.indexOf(name);
	if (index >= 0 && args[index + 1] !== undefined) return args[index + 1];
	if (fallback !== undefined) return fallback;
	throw new Error(`Missing ${name}. Usage: node ${script} --package-dir <package> --stock-root <official Pi> --output-dir <dir> [--latency-ms 0]`);
}
const packageDir = resolve(argument("--package-dir"));
const stockRoot = resolve(argument("--stock-root"));
const outputDir = resolve(argument("--output-dir"));
const latencyMs = Number(argument("--latency-ms", "0"));
const workerArm = argument("--arm", "");
const ARMS = ["sync", "a", "b"];
const CYCLES = 2;
const WINDOW = 128_000;
/** Provider requests one arm may make; the run stops beyond it. */
const MAX_REQUESTS = 80;
if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 5000) throw new Error("--latency-ms must be an integer from 0 to 5000");

const WORK_NOTE_GUIDELINE = "Call context_note after a decision";
const WRITER_REQUEST = "Return ONLY one JSON object matching this schema";
// Ground truth the recovery probes look for after the last compaction. `kind` is where a faithful writer records it.
const FACTS = [
	{ marker: "Do not deploy this synthetic service.", kind: "instructions", from: "user" },
	{ marker: "config/service.json", kind: "files", from: "user" },
	{ marker: "Port 4319 failed: address in use.", kind: "failedPaths", from: "user" },
	{ marker: "build 7 green", kind: "state", from: "log" },
	{ marker: "Use port 4318 now.", kind: "instructions", from: "user" },
	{ marker: "build 8 green", kind: "state", from: "log" },
];
// Synthetic usage counts 3 bytes per token, the preview's own conservative estimate. At about 4 bytes per token,
// typical of English, its payload guard blocks before A's preparation band is reached (see validation.md).
const tokens = (text) => Math.ceil(Buffer.byteLength(text, "utf8") / 3);
// Sized so that the turn after a log lands in A's preparation band, below the payload guard.
// The build line sits mid-log, outside the start and end that a shortened user message keeps.
const log = (cycle) =>
	`Local check log ${cycle}:\n${Array.from({ length: 6900 }, (_, i) => (i === 3000 ? `build ${6 + cycle} green` : `log ${cycle}.${String(i).padStart(4, "0")}: local check ok, port healthy`)).join("\n")}`;
/** One identical script for every arm: a ruling, a long log, a follow-up, then /compact. */
const TURNS = [
	[
		{ text: "Use port 4317. Do not deploy this synthetic service. Keep the settings in config/service.json.", notes: [] },
		{ text: log(1), notes: [{ section: "state", marker: "build 7 green" }, { section: "files", marker: "config/service.json" }] },
		{ text: "Port 4319 failed: address in use. Stay on the agreed port.", notes: [{ section: "failedPaths", marker: "Port 4319 failed: address in use." }] },
	],
	[
		{ text: "Use port 4318 now.", notes: [] },
		{ text: log(2), notes: [{ section: "state", marker: "build 8 green" }] },
		{ text: "Continue checking.", notes: [] },
	],
];

function environment(agentDir) {
	const value = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: "C.UTF-8",
		CI: "1",
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "0", // Loopback HTTP needs transport; no catalog or provider network is used.
		PI_TELEMETRY: "0",
		PI_SKIP_VERSION_CHECK: "1",
	};
	if (process.env.SystemRoot) value.SystemRoot = process.env.SystemRoot;
	return value;
}

async function worker() {
	const arm = workerArm;
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const caseDir = join(outputDir, "arms", arm);
	mkdirSync(agentDir, { recursive: true });
	for (const level of ["log", "warn", "error"]) {
		const original = console[level].bind(console);
		console[level] = (...parts) => {
			const text = parts.map(String).join(" ");
			if (commandOutput) commandOutput.push(text);
			else if (!text.includes("context-memory preview")) original(...parts);
		};
	}
	let commandOutput;
	const stockPackage = join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent");
	const stock = await import(pathToFileURL(join(stockPackage, "dist", "index.js")).href);

	let manager;
	let turn;
	const requests = [];
	let lastMainPayload = "";
	const branchText = (marker) => manager.getBranch().filter((entry) => entry.type === "message" && JSON.stringify(entry.message.content ?? "").includes(marker));
	/** A faithful writer: every fact whose marker it can see, cited to the original that contains it. */
	function writerNote(serialized) {
		const note = { instructions: [], failedPaths: [], reasons: [], state: [], nextSteps: [], files: [], gaps: [] };
		for (const fact of FACTS) {
			if (!serialized.includes(fact.marker)) continue;
			const source = branchText(fact.marker).find((entry) => entry.message.role === "user");
			if (!source) continue;
			note[fact.kind].push({ text: fact.marker, sources: [source.id], ...(fact.from === "user" ? { quote: fact.marker } : {}) });
		}
		if (!note.state.length) note.state.push({ text: "The local service check continues.", sources: [manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user").id] });
		return note;
	}
	function respond(response, model, payloadTokens, { text = "", toolCall } = {}) {
		const chunk = (delta, finish, usage) =>
			`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
		const delta = toolCall
			? { role: "assistant", tool_calls: [{ index: 0, id: `ab-${requests.length}`, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] }
			: { role: "assistant", content: text };
		const output = tokens(JSON.stringify(delta));
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.write(chunk(delta, null));
		response.write(chunk({}, toolCall ? "tool_calls" : "stop", { prompt_tokens: payloadTokens, completion_tokens: output, total_tokens: payloadTokens + output }));
		response.end("data: [DONE]\n\n");
	}
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const part of request) raw += part;
		const payload = JSON.parse(raw);
		const serialized = JSON.stringify(payload.messages ?? []);
		const payloadTokens = tokens(JSON.stringify({ messages: payload.messages, tools: payload.tools }));
		if (requests.length >= MAX_REQUESTS) {
			response.writeHead(429, { "content-type": "application/json" });
			return response.end(JSON.stringify({ error: { message: "synthetic request budget exhausted", type: "budget" } }));
		}
		if (latencyMs) await new Promise((done) => setTimeout(done, latencyMs));
		if (serialized.includes(WRITER_REQUEST)) {
			requests.push({ kind: "writer", inputTokens: payloadTokens });
			return respond(response, payload.model, payloadTokens, { text: JSON.stringify(writerNote(serialized)) });
		}
		lastMainPayload = serialized;
		requests.push({ kind: "main", inputTokens: payloadTokens });
		// With B's guideline in its system prompt, the model notes what a turn established: one search for entry
		// IDs, then the note. Without it, it writes no notes.
		if (!turn.pendingNote && serialized.includes(WORK_NOTE_GUIDELINE)) turn.pendingNote = turn.notes.shift();
		if (turn.pendingNote && !turn.searched) {
			turn.searched = true;
			return respond(response, payload.model, payloadTokens, { toolCall: { name: "context_history", args: { operation: "search", query: turn.pendingNote.marker } } });
		}
		if (turn.pendingNote) {
			const note = turn.pendingNote;
			turn.pendingNote = undefined;
			turn.searched = false;
			const fact = { text: note.marker, sources: [branchText(note.marker).at(-1).id] };
			const args = note.section === "state" ? { state: [fact] } : { state: [{ text: "Recorded during the local check.", sources: fact.sources }], [note.section]: [fact] };
			return respond(response, payload.model, payloadTokens, { toolCall: { name: "context_note", args } });
		}
		return respond(response, payload.model, payloadTokens, { text: "Checked; continuing." });
	});
	server.keepAliveTimeout = 600_000;
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const model = {
		id: "synthetic-ab",
		name: "Synthetic A/B",
		provider: "synthetic-ab",
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		reasoning: false,
		input: ["text"],
		contextWindow: WINDOW,
		maxTokens: 8192,
		// Synthetic USD per million tokens, the same for every arm; not a provider's price.
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true },
	};
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir], cacheWarming: "off", defaultTools: [], compaction: { enabled: false, keepRecentTokens: 0 } }));
	writeFileSync(join(agentDir, "pi-context-memory.json"), JSON.stringify({ previewPreparation: { enabled: arm === "a" }, previewWorkNotes: { enabled: arm === "b" } }));
	let session;
	async function open(sessionManager) {
		session?.dispose();
		manager = sessionManager;
		const runtime = await stock.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
		runtime.registerProvider(model.provider, { api: model.api, apiKey: "synthetic-ab-only", baseUrl: model.baseUrl, models: [model] });
		const settingsManager = stock.SettingsManager.create(caseDir, agentDir);
		const loader = new stock.DefaultResourceLoader({ cwd: caseDir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await loader.reload();
		if (loader.getExtensions().errors.length) throw new Error("Package load errors");
		session = (await stock.createAgentSession({ cwd: caseDir, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", sessionManager, settingsManager, resourceLoader: loader, noTools: "builtin" })).session;
		await session.bindExtensions({ onError: () => {} });
	}
	async function status() {
		commandOutput = [];
		try {
			await session.prompt("/compaction-status");
			return JSON.parse(commandOutput.join("\n"));
		} finally {
			commandOutput = undefined;
		}
	}
	const settle = async () => {
		for (let i = 0; i < 200 && (await status()).preparation?.state === "preparing"; i++) await new Promise((done) => setTimeout(done, 25));
	};
	const result = { arm, turnMs: 0, compactions: [], errors: [] };
	try {
		mkdirSync(caseDir, { recursive: true });
		await open(stock.SessionManager.create(caseDir, join(caseDir, "sessions")));
		for (const [cycle, turns] of TURNS.entries()) {
			for (const scripted of turns) {
				turn = { notes: [...scripted.notes] };
				const started = performance.now();
				await session.prompt(scripted.text);
				result.turnMs += Math.round(performance.now() - started);
				// Optional preparation runs after the turn; the next user input waits for nothing, but the script
				// lets it finish so every arm submits the same next turn.
				await settle();
			}
			const before = requests.length;
			const started = performance.now();
			let error;
			try {
				await session.compact();
			} catch (cause) {
				error = String(cause?.message ?? cause).slice(0, 200);
			}
			const wallMs = Math.round(performance.now() - started);
			const checkpoint = manager.getBranch().findLast((entry) => entry.type === "compaction");
			const after = await status();
			turn = { notes: [] };
			await session.prompt("Status check after compaction.");
			result.compactions.push({
				cycle: cycle + 1,
				...(error ? { error } : {}),
				path: checkpoint?.details?.preparation?.path ?? "sync",
				wallMs,
				pauseMs: after.lastCompaction?.pauseMs ?? null,
				foregroundWriterCalls: requests.slice(before).filter((r) => r.kind === "writer").length,
				foregroundWriterInputTokens: requests.slice(before).filter((r) => r.kind === "writer").reduce((sum, r) => sum + r.inputTokens, 0),
				contextTokensAfter: requests.at(-1)?.inputTokens ?? null,
				userMessagesCarried: checkpoint?.details?.userMessages?.length ?? 0,
				noteFacts: checkpoint ? Object.values(checkpoint.details.note).reduce((sum, items) => sum + items.length, 0) : 0,
				marker: after.state,
			});
		}
		const final = await status();
		const file = manager.getSessionFile();
		await open(stock.SessionManager.open(file));
		turn = { notes: [] };
		await session.prompt("Summarize the current port, constraints and state.");
		const restarted = await status();
		const usedCalls = new Set(manager.getEntries().flatMap((entry) => (entry.type === "compaction" ? (entry.details?.preparation?.callIds ?? []) : [])));
		const main = manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").map((entry) => entry.message.usage);
		const sum = (values, pick) => values.reduce((total, value) => total + (pick(value) ?? 0), 0);
		result.main = {
			requests: requests.filter((r) => r.kind === "main").length,
			inputTokens: sum(main, (u) => u.input),
			outputTokens: sum(main, (u) => u.output),
			cost: Number(sum(main, (u) => u.cost?.total).toFixed(6)),
		};
		result.writer = { ...final.calls, usage: { ...final.calls.usage, cost: Number(final.calls.usage.cost.toFixed(6)) } };
		result.requests = requests.map((r) => `${r.kind}:${r.inputTokens}`);
		result.discardedPreparationCalls = Math.max(0, (final.calls?.preparationCalls ?? 0) - usedCalls.size);
		result.total = {
			tokens: result.main.inputTokens + result.main.outputTokens + (final.calls?.usage?.totalTokens ?? 0),
			cost: Number((result.main.cost + (final.calls?.usage?.cost ?? 0)).toFixed(6)),
			unknownWriterUsage: final.calls?.unknownUsage ?? 0,
		};
		result.recovery = {
			restartReady: restarted.state === "ready",
			probes: Object.fromEntries(FACTS.map((fact) => [fact.marker, lastMainPayload.includes(fact.marker)])),
		};
	} catch (error) {
		result.errors.push(String(error?.stack ?? error).slice(0, 800));
	} finally {
		session?.dispose();
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
	}
	writeFileSync(join(caseDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	process.exit(0);
}

// The package's host imports must reach the Pi under test, so a copy outside any Node project is loaded.
function assertNoShadowingHost(directory) {
	for (let current = directory; ; current = dirname(current)) {
		for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]) {
			if (existsSync(join(current, "node_modules", name))) throw new Error(`${join(current, "node_modules", name)} would shadow the host under test; point TMPDIR outside any Node project`);
		}
		if (dirname(current) === current) return;
	}
}

async function parent() {
	mkdirSync(outputDir, { recursive: true });
	const build = JSON.parse(readFileSync(join(packageDir, "preview-build.json"), "utf8"));
	const hostVersion = JSON.parse(readFileSync(join(stockRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
	const isolated = mkdtempSync(join(tmpdir(), "pi-preview-ab-"));
	const candidate = join(isolated, "package");
	cpSync(packageDir, candidate, { recursive: true });
	const report = {
		providers: "loopback HTTP synthetic only",
		runnerSha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
		package: { build: build.build, sourceCommit: build.sourceCommit, sourceHash: build.sourceHash },
		host: inspectOfficialPi(stockRoot, hostVersion),
		settings: { cycles: CYCLES, latencyMs, maxRequestsPerArm: MAX_REQUESTS, contextWindow: WINDOW, syntheticPricePerMillion: { input: 3, output: 15 } },
		arms: [],
	};
	try {
		assertNoShadowingHost(candidate);
		for (const arm of ARMS) {
			const agentDir = join(outputDir, "arms", arm, "agent");
			rmSync(join(outputDir, "arms", arm), { recursive: true, force: true });
			mkdirSync(agentDir, { recursive: true });
			const child = spawn(process.execPath, [script, "--package-dir", candidate, "--stock-root", stockRoot, "--output-dir", outputDir, "--latency-ms", String(latencyMs), "--arm", arm], { cwd: outputDir, env: environment(agentDir), stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", (data) => {
				stderr = (stderr + data).slice(-2000);
			});
			const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
			const [code] = await once(child, "exit");
			clearTimeout(timer);
			const path = join(outputDir, "arms", arm, "result.json");
			const result = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { arm, errors: [`exit ${code}: ${stderr}`] };
			// Keep the compact result only; synthetic sessions and agent state are removed.
			for (const entry of ["agent", "sessions"]) rmSync(join(outputDir, "arms", arm, entry), { recursive: true, force: true });
			report.arms.push(result);
		}
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
	writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	const rows = report.arms.map((r) => {
		const c = r.compactions ?? [];
		const probes = Object.values(r.recovery?.probes ?? {});
		return [
			r.arm,
			r.turnMs,
			c.map((x) => x.path).join("/"),
			c.map((x) => x.wallMs).join("/"),
			c.map((x) => x.foregroundWriterCalls).join("/"),
			c.map((x) => x.contextTokensAfter).join("/"),
			r.main?.requests,
			r.writer?.calls,
			r.total?.tokens,
			r.total?.cost,
			r.discardedPreparationCalls,
			r.total?.unknownWriterUsage,
			`${probes.filter(Boolean).length}/${probes.length}`,
			r.errors?.length ? "error" : "ok",
		].join(" | ");
	});
	process.stdout.write(`arm | turn ms | paths | pause ms | fg writer calls | context after | main requests | writer calls | total tokens | synthetic cost | discarded prep | unknown usage | probes | run\n${rows.join("\n")}\n`);
	if (report.arms.some((r) => r.errors?.length)) process.exitCode = 1;
}

if (workerArm) await worker();
else await parent();
