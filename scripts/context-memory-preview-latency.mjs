import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectOfficialPi } from "./context-memory-preview-stock-install.mjs";

// Finite S2 interface/accounting evidence only. All HTTP is an isolated loopback
// synthetic provider. Scripted recovery answers are not semantic model evidence.
export const MEASUREMENT_VERSION = "0.4-preview-latency.1";
export const FIXTURE_VERSION = "s2-text-chain.1";
export const LIMITS = Object.freeze({ construction: 5, checkpoints: 2, probes: 6, probeCalls: 12, foregroundCalls: 18, preparationCalls: 16, wallMs: 1_800_000, foregroundDeadlineMs: 600_000, preparationWaitMs: 120_000 });
const usage = "Usage: node scripts/context-memory-preview-latency.mjs --package-dir <candidate> --stock-root <official Pi 1.1.0> --output-dir <evidence> --strategy <synchronous|background> --writer <session|fixed> [--preparation-settings <JSON-file>]";
const script = fileURLToPath(import.meta.url);
const repository = fileURLToPath(new URL("../", import.meta.url));
const systemPrompt = "Synthetic S2 task. Original user decisions govern permissions. Verify original evidence with context_history before acting. Do not repeat completed inspection.";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export function hashEntries(entries) {
	const hash = createHash("sha256");
	for (const entry of entries) hash.update(JSON.stringify(entry)).update("\n");
	return hash.digest("hex");
}

export function parseLatencyArguments(args) {
	const keys = { "--package-dir": "packageDir", "--stock-root": "stockRoot", "--output-dir": "outputDir", "--strategy": "strategy", "--writer": "writer", "--preparation-settings": "preparationSettings", "--worker": "worker", "--work-dir": "workDir", "--session-file": "sessionFile", "--boundary": "boundary", "--probe": "probe" };
	const options = {};
	for (let index = 0; index < args.length; index++) {
		const key = keys[args[index]];
		if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(usage);
		options[key] = args[++index];
	}
	if (!["packageDir", "stockRoot", "outputDir", "strategy", "writer"].every((key) => options[key])) throw new Error(usage);
	if (!["synchronous", "background"].includes(options.strategy) || !["session", "fixed"].includes(options.writer)) throw new Error(usage);
	if (options.strategy === "background" && !options.preparationSettings) throw new Error("Background comparison requires --preparation-settings with the complete declared opt-in policy");
	if (options.worker && (!["chain", "probe"].includes(options.worker) || !options.workDir)) throw new Error(usage);
	if (options.worker === "probe" && (!options.sessionFile || !["1", "2"].includes(options.boundary) || !["exact", "authority", "action"].includes(options.probe))) throw new Error(usage);
	for (const key of ["packageDir", "stockRoot", "outputDir", "preparationSettings", "workDir", "sessionFile"]) if (options[key]) options[key] = resolve(options[key]);
	return options;
}

export function fixtureRecipe() {
	const trace = Array.from({ length: 6000 }, (_, index) => `trace ${String(index).padStart(5, "0")}: local check ok, port 4317 healthy`).join("\n");
	return {
		version: FIXTURE_VERSION,
		initial: "Use port 4317. Do not deploy this synthetic service. You may rotate the synthetic local credential. Initial inspection is already complete; do not repeat it. Next check the local health endpoint.",
		rulings: ["Keep port 4317. Credential rotation is still permitted. Initial inspection is already complete; do not repeat it. Next check the local health endpoint.", "Use port 4318 instead of 4317. Permission to rotate the synthetic local credential is revoked. Do not deploy this synthetic service. Initial inspection is already complete; do not repeat it. Next check the local health endpoint."],
		traces: [1, 2].map((cycle) => `Trace batch ${cycle}:\n${trace}`),
		boundaries: [{ cycle: 1, afterTurn: 3, expectedPort: 4317, rotationAllowed: true }, { cycle: 2, afterTurn: 5, expectedPort: 4318, rotationAllowed: false }],
		retention: { extensionKeepRecentTokens: 0, piKeepRecentTokens: 1, expectedCut: "complete completed-turn branch; no originals retained" },
	};
}

// Preserve unsupported fields as unknown: a synthetic SDK zero is not provider evidence.
export function syntheticUsage(payload, text) {
	const input = Math.ceil(Buffer.byteLength(JSON.stringify(payload.messages ?? []), "utf8") / 3);
	const output = Math.ceil(Buffer.byteLength(text, "utf8") / 3);
	return { input, output, totalTokens: input + output, cacheRead: 0, cacheWrite: null, reasoning: null, costMicros: null, kind: "synthetic", currency: "USD", costSource: "unavailable" };
}

export function summarizeCalls(calls) {
	const totals = { calls: calls.length, succeeded: 0, failed: 0, unknownUsage: 0, usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costMicros: 0 }, unknown: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costMicros: 0 }, byPurpose: {} };
	for (const call of calls) {
		if (call.outcome === "succeeded") totals.succeeded++;
		else totals.failed++;
		totals.byPurpose[call.purpose] = (totals.byPurpose[call.purpose] ?? 0) + 1;
		if (!call.usage) totals.unknownUsage++;
		for (const key of Object.keys(totals.usage)) {
			const value = call.usage?.[key];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) totals.usage[key] += value;
			else totals.unknown[key]++;
		}
	}
	return totals;
}

export function plannedCounts(boundaries = [], probes = []) {
	const count = (records, planned) => ({ planned, started: records.filter((record) => record.state !== "unstarted").length, completed: records.filter((record) => record.state === "completed").length, failed: records.filter((record) => record.state === "failed").length, blocked: records.filter((record) => record.state === "blocked").length, unstarted: planned - records.filter((record) => record.state !== "unstarted").length });
	return { checkpoints: count(boundaries, LIMITS.checkpoints), probes: count(probes, LIMITS.probes) };
}

function environment(agentDir) {
	const value = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", CI: "1", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "0", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", npm_config_offline: "true" };
	if (process.env.SystemRoot) value.SystemRoot = process.env.SystemRoot;
	return value;
}

function safeError(error) {
	const code = String(error?.message ?? error).slice(0, 200).match(/^(?:CONTEXT|HISTORY|S2)_[A-Z_]+\b/)?.[0];
	return code ?? "S2_HARNESS_FAILED";
}

function assertNoShadowingHost(directory) {
	for (let current = directory; ; current = dirname(current)) {
		for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]) if (existsSync(join(current, "node_modules", name))) throw new Error("S2_SHADOWED_OFFICIAL_HOST");
		if (dirname(current) === current) return;
	}
}

function preparedSettings(options) {
	if (options.strategy !== "background") return { enabled: false };
	const value = JSON.parse(readFileSync(options.preparationSettings, "utf8"));
	assert(value && typeof value === "object" && !Array.isArray(value) && value.enabled === true, "S2_PREPARATION_POLICY_REQUIRED");
	const allowed = ["enabled", "minSourceTokens", "minIntervalMs", "deadlineMs", "maxCallsPerAttempt", "ledger"];
	assert(Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => key in value), "S2_PREPARATION_POLICY_INVALID");
	assert(Number.isSafeInteger(value.minSourceTokens) && value.minSourceTokens > 0 && Number.isSafeInteger(value.minIntervalMs) && value.minIntervalMs >= 0, "S2_PREPARATION_POLICY_INVALID");
	assert(Number.isSafeInteger(value.deadlineMs) && value.deadlineMs > 0 && value.deadlineMs <= LIMITS.preparationWaitMs, "S2_PREPARATION_POLICY_INVALID");
	assert(Number.isSafeInteger(value.maxCallsPerAttempt) && value.maxCallsPerAttempt > 0 && value.maxCallsPerAttempt <= 8, "S2_PREPARATION_POLICY_INVALID");
	const ledger = value.ledger;
	const ceilings = { maxAttemptsPerInterval: 1, maxCallsPerInterval: 8, maxCallsPerSession: 16, maxReservedTokensPerInterval: 1_200_000, maxReservedTokensPerSession: 2_400_000, maxReservedCostMicrosPerInterval: 1_000_000, maxReservedCostMicrosPerSession: 2_000_000, maxDetails: 256 };
	assert(ledger && typeof ledger === "object" && !Array.isArray(ledger) && Object.keys(ledger).length === Object.keys(ceilings).length && Object.entries(ceilings).every(([key, ceiling]) => Number.isSafeInteger(ledger[key]) && ledger[key] > 0 && ledger[key] <= ceiling), "S2_PREPARATION_POLICY_INVALID");
	assert(value.maxCallsPerAttempt <= ledger.maxCallsPerInterval && ledger.maxCallsPerInterval <= ledger.maxCallsPerSession && ledger.maxReservedTokensPerInterval <= ledger.maxReservedTokensPerSession && ledger.maxReservedCostMicrosPerInterval <= ledger.maxReservedCostMicrosPerSession, "S2_PREPARATION_POLICY_INVALID");
	return value;
}

function stream(response, model, text, tools, accounting) {
	const chunk = (delta, finish, returnedUsage) => `data: ${JSON.stringify({ id: "s2-synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(returnedUsage ? { usage: returnedUsage } : {}) })}\n\n`;
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	response.write(chunk({ role: "assistant", content: text, ...(tools.length ? { tool_calls: tools.map((tool, index) => ({ index, id: `s2-tool-${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } })) } : {}) }, null));
	response.write(chunk({}, tools.length ? "tool_calls" : "stop", { prompt_tokens: accounting.input, completion_tokens: accounting.output, total_tokens: accounting.totalTokens, prompt_tokens_details: { cached_tokens: accounting.cacheRead } }));
	response.end("data: [DONE]\n\n");
}

function messageText(entry) {
	if (typeof entry.message.content === "string") return entry.message.content;
	return entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function sourceEntries(manager, recipe) {
	return manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user" && [recipe.initial, ...recipe.rulings].includes(messageText(entry)));
}

function oracle(manager, recipe) {
	const entries = sourceEntries(manager, recipe);
	const initial = entries.find((entry) => messageText(entry) === recipe.initial);
	const latest = entries.findLast((entry) => recipe.rulings.includes(messageText(entry))) ?? initial;
	assert(initial && latest, "S2_MISSING_ORIGINAL");
	const changed = messageText(latest) === recipe.rulings[1];
	return { initial, latest, port: changed ? 4318 : 4317, rotationAllowed: !changed };
}

function scriptedNote(manager, recipe) {
	const expected = oracle(manager, recipe);
	const newer = expected.latest.id !== expected.initial.id;
	const supersedes = newer ? { supersedes: [expected.initial.id] } : {};
	return {
		instructions: [
			{ text: "Deployment remains unauthorized.", sources: [expected.initial.id], quote: "Do not deploy this synthetic service." },
			{ text: expected.rotationAllowed ? "Credential rotation is permitted." : "Credential rotation permission is revoked.", sources: [expected.latest.id], quote: expected.rotationAllowed ? (newer ? "Credential rotation is still permitted." : "You may rotate the synthetic local credential.") : "Permission to rotate the synthetic local credential is revoked.", ...supersedes },
		],
		failedPaths: [], reasons: [],
		state: [{ text: `The synthetic service uses port ${expected.port}.`, sources: [expected.latest.id], ...supersedes }, { text: "Initial inspection is already complete and must not repeat.", sources: [expected.initial.id] }],
		nextSteps: [{ text: `Check the local health endpoint on port ${expected.port}.`, sources: [expected.latest.id] }],
		files: [], gaps: [],
	};
}

async function worker(options) {
	const started = performance.now();
	const agentDir = join(options.workDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const recipe = fixtureRecipe();
	const preparation = options.worker === "chain" ? preparedSettings(options) : { enabled: false };
	const config = { enabled: true, writerModel: options.writer === "session" ? "session" : "s2-synthetic/s2-fixed", writerEffort: "medium", eventLog: false, noteRepair: false, keepRecentTokens: 0, previewPreparation: preparation };
	const settingsValue = { packages: [options.packageDir], compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", defaultTools: [] };
	writeFileSync(join(agentDir, "pi-context-memory.json"), JSON.stringify(config));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settingsValue));
	let commandOutput;
	const originalConsole = {};
	for (const level of ["log", "warn", "error"]) {
		originalConsole[level] = console[level];
		console[level] = (...parts) => { if (commandOutput) commandOutput.push(parts.map(String).join(" ")); };
	}
	const stockPackage = join(options.stockRoot, "node_modules/@earendil-works/pi-coding-agent");
	const stock = await import(pathToFileURL(join(stockPackage, "dist/index.js")).href);
	assert.equal(stock.VERSION, "1.1.0", "S2_OFFICIAL_VERSION_MISMATCH");
	const calls = [];
	const diagnostics = [];
	const actions = [];
	const historyResults = [];
	const statusPolls = [];
	const turns = [];
	const boundaries = [];
	let manager;
	let session;
	let phase = options.worker === "chain" ? "construction" : "probe";
	let boundary = options.worker === "chain" ? 1 : Number(options.boundary);
	let probeStep = 0;
	let expectedHistory = 0;
	let syntheticStopped = false;
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const part of request) raw += part;
		let payload;
		try { payload = JSON.parse(raw); } catch { response.writeHead(400); response.end(); return; }
		const writer = JSON.stringify(payload.messages ?? []).includes("Return ONLY one JSON object matching this schema");
		const purpose = writer ? (phase === "compaction" ? "foreground" : "preparation") : options.worker === "probe" ? "probe" : "task";
		const purposeCount = calls.filter((call) => call.purpose === purpose).length;
		const boundaryCount = calls.filter((call) => call.purpose === purpose && call.boundary === boundary).length;
		const maximum = { task: LIMITS.construction, probe: options.probe === "action" ? 4 : 1, foreground: LIMITS.foregroundCalls, preparation: LIMITS.preparationCalls }[purpose];
		const record = { callId: `s2-${options.worker === "chain" ? "chain" : `probe-${boundary}-${options.probe}`}-${calls.length + 1}`, purpose, boundary, model: payload.model, effort: payload.reasoning_effort ?? "off", dispatchedMs: Math.round(performance.now() - started), requestBytes: Buffer.byteLength(raw), messagesSha256: sha256(JSON.stringify(payload.messages ?? [])), schemaSha256: sha256(JSON.stringify(payload.tools ?? [])), outcome: "failed" };
		calls.push(record);
		if (purposeCount >= maximum || (purpose === "foreground" && boundaryCount >= 9) || (purpose === "preparation" && boundaryCount >= 8)) { record.error = "S2_CALL_LIMIT"; response.writeHead(429); response.end(); return; }
		let text;
		let tools = [];
		if (writer) text = JSON.stringify(scriptedNote(manager, recipe));
		else if (options.worker === "chain") text = "The synthetic local task turn is complete.";
		else {
			const expected = oracle(manager, recipe);
			if (probeStep++ === 0) {
				const ids = [...new Set([expected.initial.id, expected.latest.id])];
				expectedHistory = ids.length;
				tools = ids.map((entryId) => ({ name: "context_history", arguments: { operation: "read", entryId } }));
				text = options.probe === "exact" ? JSON.stringify({ port: expected.port, sources: [expected.latest.id] }) : options.probe === "authority" ? JSON.stringify({ deployAllowed: false, rotationAllowed: expected.rotationAllowed, sources: ids }) : "Read original decisions before taking the next action.";
			} else if (options.probe === "action" && probeStep === 2) {
				text = "Check the remaining local health endpoint.";
				tools = [{ name: "s2_action", arguments: { action: "check-health", port: expected.port } }];
			} else text = "The local health check is complete.";
		}
		record.usage = syntheticUsage(payload, text + JSON.stringify(tools));
		stream(response, payload.model, text, tools, record.usage);
		record.terminalMs = Math.round(performance.now() - started);
		record.elapsedMs = record.terminalMs - record.dispatchedMs;
		record.outcome = "succeeded";
	});
	server.keepAliveTimeout = 600_000;
	server.headersTimeout = 610_000;
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	const model = { id: "s2-task", name: "Synthetic S2 task", provider: "s2-synthetic", api: "openai-completions", baseUrl, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true } };
	let result = { measurementVersion: MEASUREMENT_VERSION, fixtureVersion: FIXTURE_VERSION, fixtureSha256: sha256(JSON.stringify(recipe)), provider: "loopback synthetic only", semanticEvidence: false, strategy: options.strategy, writer: options.writer, worker: options.worker, calls, diagnostics, turns, boundaries, statusPolls, completed: false };
	try {
		const runtime = await stock.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
		runtime.registerProvider(model.provider, { api: model.api, apiKey: "s2-loopback-synthetic-only", baseUrl, models: [model, { ...model, id: "s2-fixed", name: "Synthetic S2 fixed writer" }] });
		manager = options.sessionFile ? stock.SessionManager.open(options.sessionFile) : stock.SessionManager.create(options.workDir, join(options.workDir, "sessions"));
		const baselineBranch = structuredClone(manager.getBranch());
		const settings = stock.SettingsManager.create(options.workDir, agentDir);
		const loader = new stock.DefaultResourceLoader({ cwd: options.workDir, agentDir, settingsManager: settings, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => systemPrompt });
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, [], "S2_PACKAGE_LOAD_FAILED");
		assert(loaded.extensions.some((extension) => extension.path.startsWith(options.packageDir)), "S2_PACKAGE_NOT_LOADED");
		const created = await stock.createAgentSession({ cwd: options.workDir, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: "builtin", customTools: [{ name: "s2_action", label: "Synthetic local action", description: "Perform a synthetic local action. Real files, credentials and services are never accessed.", parameters: { type: "object", properties: { action: { type: "string", enum: ["check-health", "initial-inspection", "deploy", "rotate-credential"] }, port: { type: "integer" } }, required: ["action", "port"], additionalProperties: false }, async execute(_id, parameters) { actions.push(parameters); return { content: [{ type: "text", text: "Synthetic action recorded." }], details: { action: parameters.action, port: parameters.port } }; } }] });
		session = created.session;
		await session.bindExtensions({ onError: (error) => diagnostics.push(safeError(error)) });
		session.subscribe((event) => {
			if (event.type !== "tool_execution_end" || event.toolName !== "context_history") return;
			historyResults.push(event.result);
			if (options.worker === "probe" && options.probe !== "action" && historyResults.length === expectedHistory) {
				// The first two probes have a one-request ceiling. Stop after the real
				// tool batch; the scripted answer and retrieved originals are sufficient
				// to exercise the independent probe/scorer interface.
				syntheticStopped = true;
				void session.abort();
			}
		});
		async function status() {
			const taskBefore = calls.filter((call) => call.purpose === "task" || call.purpose === "probe").length;
			commandOutput = [];
			try {
				await session.prompt("/compaction-status");
				// A running writer may dispatch its next chunk while the read-only
				// command yields. Only ordinary/control requests prove a command leak.
				assert.equal(calls.filter((call) => call.purpose === "task" || call.purpose === "probe").length, taskBefore, "S2_STATUS_REACHED_PROVIDER");
				const value = JSON.parse(commandOutput.join("\n"));
				const preparation = value.preparation ?? null;
				// Keep the first observation of each ledger/state change instead of
				// duplicating unchanged cumulative accounting on every 25ms poll.
				const changed = statusPolls.at(-1)?.identity !== sha256(JSON.stringify({ state: value.state, preparation }));
				if (changed) statusPolls.push({ elapsedMs: Math.round(performance.now() - started), state: value.state, preparation, providerCalls: 0, identity: sha256(JSON.stringify({ state: value.state, preparation })) });
				result.statusPollCount = (result.statusPollCount ?? 0) + 1;
				return value;
			} finally { commandOutput = undefined; }
		}
		function storage() {
			let ledgerBytes = 0;
			let ledgerFiles = 0;
			function visit(directory) {
				if (!existsSync(directory)) return;
				for (const entry of readdirSync(directory, { withFileTypes: true })) {
					const file = join(directory, entry.name);
					if (entry.isDirectory()) visit(file);
					else if (entry.isFile()) { ledgerBytes += statSync(file).size; ledgerFiles++; }
				}
			}
			visit(join(agentDir, "context-memory-preview", "preparation"));
			return { sessionBytes: statSync(manager.getSessionFile()).size, preparationLedgerBytes: ledgerBytes, preparationLedgerFiles: ledgerFiles };
		}
		async function waitPreparation() {
			if (options.strategy !== "background") return;
			const waitStart = performance.now();
			let value = await status();
			assert(value.preparation && value.preparation.enabled === true, "S2_PREPARATION_NOT_ENABLED");
			while (value.preparation.inFlight || value.preparation.state === "preparing") {
				if (performance.now() - waitStart > LIMITS.preparationWaitMs) throw new Error("S2_PREPARATION_TIMEOUT");
				await new Promise((done) => setTimeout(done, 25));
				value = await status();
			}
			return { waitMs: Math.round(performance.now() - waitStart), state: value.preparation.state, reason: value.preparation.reason ?? null, candidateId: value.preparation.candidateId ?? null };
		}
		async function prompt(text, number) {
			phase = "construction";
			const before = calls.length;
			const turnStart = performance.now();
			await session.prompt(text);
			const newCalls = calls.slice(before);
			assert.equal(newCalls.filter((call) => call.purpose === "task").length, 1, "S2_CONSTRUCTION_REQUEST_COUNT");
			turns.push({ turn: number, sourceSha256: sha256(text), wallMs: Math.round(performance.now() - turnStart), taskCallIds: newCalls.filter((call) => call.purpose === "task").map((call) => call.callId), concurrentPreparationCallIds: newCalls.filter((call) => call.purpose === "preparation").map((call) => call.callId) });
		}
		if (options.worker === "chain") {
			await prompt(recipe.initial, 1);
			for (let cycle = 1; cycle <= LIMITS.checkpoints; cycle++) {
				boundary = cycle;
				await prompt(recipe.rulings[cycle - 1], cycle * 2);
				const rulingPreparation = await waitPreparation();
				await prompt(recipe.traces[cycle - 1], cycle * 2 + 1);
				const tracePreparation = await waitPreparation();
				phase = "compaction";
				const before = structuredClone(manager.getBranch());
				const contextBefore = manager.buildSessionContext();
				const preflight = { leafId: manager.getLeafId(), sourceHash: hashEntries(before), sourceIds: before.map((entry) => entry.id), originalIds: before.filter((entry) => entry.type === "message").map((entry) => entry.id), safeCutHash: hashEntries([{ leafId: manager.getLeafId(), keepRecentTokens: 0, boundary: cycle }]), systemSha256: sha256(session.systemPrompt ?? ""), projectedMessagesHash: hashEntries(contextBefore.messages), projectedBytes: Buffer.byteLength(JSON.stringify(contextBefore.messages)) };
				const previousCalls = calls.length;
				const compactStart = performance.now();
				const row = { boundary: cycle, state: "failed", preflight, preparationAfterRuling: rulingPreparation ?? null, preparationAfterTrace: tracePreparation ?? null };
				boundaries.push(row);
				let deadlineReached = false;
				const compactTimer = setTimeout(() => { deadlineReached = true; session.abortCompaction(); }, LIMITS.foregroundDeadlineMs);
				try {
					await session.compact();
					if (deadlineReached) throw new Error("S2_FOREGROUND_TIMEOUT");
					row.pauseMs = Math.round(performance.now() - compactStart);
					row.foregroundCallIds = calls.slice(previousCalls).map((call) => call.callId);
					const disk = stock.SessionManager.open(manager.getSessionFile());
					const checkpoint = disk.getBranch().findLast((entry) => entry.type === "compaction");
					assert(checkpoint?.details?.kind === "pi-context-memory", "S2_NO_PREVIEW_CHECKPOINT");
					assert.equal(checkpoint.details.coveredThrough, before.at(-1).id, "S2_COVERAGE_MISMATCH");
					assert.equal(checkpoint.details.sourceHash, preflight.sourceHash, "S2_SOURCE_HASH_MISMATCH");
					assert.equal(hashEntries(disk.getBranch().slice(0, before.length)), preflight.sourceHash, "S2_DISK_ORIGINALS_CHANGED");
					const keptIndex = before.findIndex((entry) => entry.id === checkpoint.firstKeptEntryId);
					const retained = keptIndex < 0 ? [] : before.slice(keptIndex);
					const released = keptIndex < 0 ? before : before.slice(0, keptIndex);
					assert.equal(retained.length, 0, "S2_RETENTION_POLICY_CHANGED");
					const current = await status();
					assert.equal(current.state, "ready", "S2_COMMIT_NOT_CONFIRMED");
					row.state = "completed";
					row.checkpoint = { id: checkpoint.id, sha256: hashEntries([checkpoint]), build: checkpoint.details.build, firstKeptEntryId: checkpoint.firstKeptEntryId, coveredThrough: checkpoint.details.coveredThrough, sourceHash: checkpoint.details.sourceHash, noteSha256: sha256(JSON.stringify(checkpoint.details.note)), noteBytes: Buffer.byteLength(JSON.stringify(checkpoint.details.note)), summarySha256: sha256(checkpoint.summary), summaryBytes: Buffer.byteLength(checkpoint.summary), releasedHash: hashEntries(released), retainedHash: hashEntries(retained), releasedIds: released.map((entry) => entry.id), retainedIds: retained.map((entry) => entry.id), noteBudget: checkpoint.details.noteBudget ?? null, preparation: checkpoint.details.preparation ?? null, usage: checkpoint.usage ?? null, diskConfirmed: true };
					row.path = checkpoint.details.preparation?.path ?? "sync";
					for (const call of calls.slice(previousCalls)) call.compactionPath = row.path;
					row.lastCompaction = current.lastCompaction ?? null;
					row.phaseTimings = { pauseMs: row.pauseMs, providerResponseMs: calls.slice(previousCalls).reduce((sum, call) => sum + (call.elapsedMs ?? 0), 0), generationMs: null, validationMs: null, stageMs: null, diskConfirmationMs: null, unknownReason: "official SDK exposes no separate phase clocks; raw HTTP response time is recorded separately" };
					row.contextAfter = { messagesHash: hashEntries(disk.buildSessionContext().messages), bytes: Buffer.byteLength(JSON.stringify(disk.buildSessionContext().messages)) };
					row.storage = storage();
					cpSync(manager.getSessionFile(), join(options.workDir, `checkpoint-${cycle}.jsonl`));
				} catch (error) { row.error = safeError(error); throw error; }
				finally { clearTimeout(compactTimer); }
			}
			result.finalStatus = await status();
			result.storage = storage();
			result.config = config;
			result.piSettings = settingsValue.compaction;
			result.models = { task: { provider: model.provider, id: model.id, api: model.api, thinking: "off", contextWindow: model.contextWindow, maxTokens: model.maxTokens }, writer: { selector: config.writerModel, actual: options.writer === "session" ? "s2-synthetic/s2-task" : "s2-synthetic/s2-fixed", effort: "off" }, preparationRole: options.strategy === "background" ? "configured-writer arm A" : "none" };
		} else {
			const expected = oracle(manager, recipe);
			const restoredContext = manager.buildSessionContext();
			const probeStart = performance.now();
			await session.prompt(options.probe === "exact" ? "What is the current port? Cite and retrieve the original ruling." : options.probe === "authority" ? "What actions are currently permitted? Retrieve the original restrictions and revocations." : "Take the actual next permitted local action; do not repeat completed work.");
			const excerpts = historyResults.flatMap((value) => value.details?.entries ?? []);
			const originalEntries = [...new Set([expected.initial.id, expected.latest.id])].map((id) => baselineBranch.find((entry) => entry.id === id));
			const support = originalEntries.every((entry) => excerpts.some((excerpt) => excerpt.entryId === entry.id && excerpt.role === "user" && excerpt.text === messageText(entry)));
			const forbidden = actions.filter((action) => action.action === "deploy" || (!expected.rotationAllowed && action.action === "rotate-credential")).length;
			const repeated = actions.filter((action) => action.action === "initial-inspection").length;
			const actual = actions.length === 1 && actions[0].action === "check-health" && actions[0].port === expected.port;
			const continuation = manager.getBranch().slice(baselineBranch.length);
			const toolRounds = continuation.filter((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall")).length;
			assert(actions.length <= 2 && toolRounds <= 3, "S2_PROBE_ACTION_LIMIT");
			const firstAssistant = continuation.find((entry) => entry.type === "message" && entry.message.role === "assistant");
			const answerText = firstAssistant?.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			let answer;
			if (options.probe !== "action") answer = JSON.parse(answerText);
			const exact = options.probe === "exact" ? answer.port === expected.port && answer.sources.includes(expected.latest.id) : null;
			const authority = options.probe === "authority" ? answer.deployAllowed === false && answer.rotationAllowed === expected.rotationAllowed : null;
			const passed = support && forbidden === 0 && repeated === 0 && (options.probe === "action" ? actual : options.probe === "exact" ? exact : authority);
			result.probe = { boundary, probe: options.probe, state: passed ? "completed" : "failed", syntheticVerdict: { exact, sourceSupport: support, authority, actualAction: options.probe === "action" ? actual : null, repeatedActions: repeated, forbiddenActions: forbidden }, port: expected.port, rotationAllowed: expected.rotationAllowed, historyReads: historyResults.length, toolRounds, providerRequests: calls.length, actions: actions.map((action) => ({ action: action.action, port: action.port })), intentionalOneRequestStop: syntheticStopped, wallMs: Math.round(performance.now() - probeStart), restoredSourceHash: hashEntries(baselineBranch), projectedMessagesHash: hashEntries(restoredContext.messages), originalHashes: originalEntries.map((entry) => ({ id: entry.id, sha256: hashEntries([entry]) })), sourceSupportHashes: excerpts.map((excerpt) => ({ id: excerpt.entryId, textSha256: sha256(excerpt.text) })), stopReason: manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant")?.message.stopReason ?? "unknown" };
			assert(passed, "S2_SCRIPTED_PROBE_FAILED");
		}
		result.completed = true;
	} catch (error) { result.error = safeError(error); }
	finally {
		session?.dispose();
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
		for (const level of ["log", "warn", "error"]) console[level] = originalConsole[level];
	}
	result.wallMs = Math.round(performance.now() - started);
	result.callTotals = summarizeCalls(calls);
	writeFileSync(join(options.workDir, "worker-result.json"), `${JSON.stringify(result, null, 2)}\n`);
	return result;
}

async function runWorker(options, extra, timeoutMs = LIMITS.wallMs) {
	mkdirSync(extra.workDir, { recursive: true });
	const parameters = [script, "--package-dir", options.packageDir, "--stock-root", options.stockRoot, "--output-dir", options.outputDir, "--strategy", options.strategy, "--writer", options.writer, "--worker", extra.worker, "--work-dir", extra.workDir];
	if (options.preparationSettings) parameters.push("--preparation-settings", options.preparationSettings);
	for (const key of ["sessionFile", "boundary", "probe"]) if (extra[key]) parameters.push(`--${key === "sessionFile" ? "session-file" : key}`, String(extra[key]));
	const child = spawn(process.execPath, parameters, { cwd: extra.workDir, env: environment(join(extra.workDir, "agent")), stdio: ["ignore", "ignore", "pipe"] });
	let errorCode = "S2_WORKER_FAILED";
	child.stderr.on("data", (value) => { errorCode = safeError(String(value)); });
	const timer = setTimeout(() => { errorCode = "S2_WALL_LIMIT"; child.kill("SIGKILL"); }, Math.max(1, timeoutMs));
	try {
		const [code] = await once(child, "exit");
		const resultFile = join(extra.workDir, "worker-result.json");
		if (existsSync(resultFile)) return { ...JSON.parse(readFileSync(resultFile, "utf8")), exitCode: code };
		return { completed: false, error: errorCode, exitCode: code, calls: [], boundaries: [], probe: extra.worker === "probe" ? { boundary: Number(extra.boundary), probe: extra.probe, state: "failed" } : undefined };
	} finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
}

function sourceIdentity() {
	const git = (args) => { const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", timeout: 10_000 }); return result.status === 0 ? result.stdout : null; };
	const commit = git(["rev-parse", "HEAD"]);
	const diff = git(["diff", "HEAD", "--binary"]);
	const paths = (git(["ls-files", "--others", "--exclude-standard", "-z", "--", "packages/coding-agent/src/extensions/context-memory", "scripts/context-memory-*.mjs", "packages/coding-agent/test/context-memory*.test.ts", "docs/context-memory/v0.4.0*.md"]) ?? "").split("\0").filter(Boolean).sort();
	return { commit: commit?.trim() ?? null, dirtyDiffSha256: diff === null ? null : sha256(diff), untracked: paths.filter((path) => existsSync(join(repository, path)) && statSync(join(repository, path)).isFile()).map((path) => ({ path, sha256: sha256(readFileSync(join(repository, path))) })) };
}

export async function runLatency(options, dispatch = runWorker) {
	mkdirSync(options.outputDir, { recursive: true });
	const packageDir = realpathSync(options.packageDir);
	const official = inspectOfficialPi(options.stockRoot, "1.1.0");
	const build = JSON.parse(readFileSync(join(packageDir, "preview-build.json"), "utf8"));
	const packageManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const archive = join(dirname(packageDir), `${packageManifest.name}-${packageManifest.version}.tgz`);
	const recipe = fixtureRecipe();
	const preparation = preparedSettings(options);
	const manifest = { measurementVersion: MEASUREMENT_VERSION, fixtureVersion: FIXTURE_VERSION, fixtureSha256: sha256(JSON.stringify(recipe)), scorerSha256: sha256(readFileSync(script)), source: sourceIdentity(), artifact: { build: build.build, version: packageManifest.version, sourceHash: build.sourceHash, bundleSha256: sha256(readFileSync(join(packageDir, "dist/extension.js"))), manifestSha256: sha256(readFileSync(join(packageDir, "package.json"))), archiveSha256: existsSync(archive) ? sha256(readFileSync(archive)) : null, archiveReason: existsSync(archive) ? null : "not supplied beside package directory" }, official, environment: { node: process.version, os: platform(), architecture: arch() }, strategy: options.strategy, writer: options.writer, preparation, configuration: { enabled: true, writerModel: options.writer === "session" ? "session" : "s2-synthetic/s2-fixed", writerEffort: "medium", eventLog: false, noteRepair: false, keepRecentTokens: 0, previewPreparation: preparation }, piCompaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 }, retention: recipe.retention, customInstructionsSha256: sha256(""), systemPromptSha256: sha256(systemPrompt), models: { task: { provider: "s2-synthetic", id: "s2-task", api: "openai-completions", effort: "off", contextWindow: 128_000, maxTokens: 8192 }, writer: { provider: "s2-synthetic", id: options.writer === "session" ? "s2-task" : "s2-fixed", effort: "off", contextWindow: 128_000, maxTokens: 8192 }, preparation: options.strategy === "background" ? "configured writer, arm A" : "none" }, planned: { chains: 1, constructionTaskRequests: LIMITS.construction, checkpoints: LIMITS.checkpoints, independentProbes: LIMITS.probes }, limits: LIMITS, order: ["construction-chain", "checkpoint-1/exact", "checkpoint-1/authority", "checkpoint-1/action", "checkpoint-2/exact", "checkpoint-2/authority", "checkpoint-2/action"], accounting: { usage: "synthetic provider units; cache write/reasoning/billed cost unknown", ledger: "preview preparation ledger; direct raw HTTP calls also counted", chargedProviderRetries: 0, currency: "USD", costCatalog: "none; synthetic model catalog zero is not billed cost" }, residentReference: { buildFileSha256: sha256(readFileSync(join(repository, "packages/coding-agent/src/extensions/context-memory/build.ts"))), runtimeFileSha256: sha256(readFileSync(join(repository, "eval/runtime.ts"))) }, semanticEvidence: false };
	const isolatedRoot = mkdtempSync(join(tmpdir(), "pi-preview-latency-"));
	const candidate = join(isolatedRoot, "package");
	const chainDir = join(isolatedRoot, "chain");
	const runOptions = { ...options, packageDir: candidate };
	const report = { manifest, comparisonId: sha256(JSON.stringify(manifest)), host: "official npm Pi 1.1.0", provider: "loopback synthetic only", semanticEvidence: false, chain: null, probes: [], passed: false };
	writeFileSync(join(options.outputDir, "manifest.json"), `${JSON.stringify({ comparisonId: report.comparisonId, ...manifest }, null, 2)}\n`);
	const deadline = Date.now() + LIMITS.wallMs;
	cpSync(packageDir, candidate, { recursive: true });
	try {
		assertNoShadowingHost(candidate);
		report.chain = await dispatch(runOptions, { worker: "chain", workDir: chainDir }, deadline - Date.now());
		for (let boundary = 1; boundary <= LIMITS.checkpoints; boundary++) {
			for (const probe of ["exact", "authority", "action"]) {
				const snapshot = join(chainDir, `checkpoint-${boundary}.jsonl`);
				if (!existsSync(snapshot)) { report.probes.push({ boundary, probe, state: "unstarted", reason: "checkpoint-unavailable" }); continue; }
				if (Date.now() >= deadline) { report.probes.push({ boundary, probe, state: "unstarted", reason: "wall-limit" }); continue; }
				const workDir = join(isolatedRoot, `probe-${boundary}-${probe}`);
				mkdirSync(workDir, { recursive: true });
				const sessionFile = join(workDir, "snapshot.jsonl");
				cpSync(snapshot, sessionFile);
				const outcome = await dispatch(runOptions, { worker: "probe", workDir, sessionFile, boundary, probe }, deadline - Date.now());
				report.probes.push({ ...(outcome.probe ?? { boundary, probe, state: "failed" }), error: outcome.error, calls: outcome.calls, callTotals: outcome.callTotals, diagnostics: outcome.diagnostics, exitCode: outcome.exitCode });
			}
		}
		report.counts = plannedCounts(report.chain.boundaries, report.probes);
		report.callTotals = summarizeCalls([...report.chain.calls, ...report.probes.flatMap((probe) => probe.calls ?? [])]);
		report.pathCounts = {};
		for (const boundary of report.chain.boundaries) report.pathCounts[boundary.path ?? "unselected"] = (report.pathCounts[boundary.path ?? "unselected"] ?? 0) + 1;
		report.passed = report.chain.completed && report.counts.checkpoints.completed === LIMITS.checkpoints && report.counts.probes.completed === LIMITS.probes && report.callTotals.failed === 0;
	} finally { rmSync(isolatedRoot, { recursive: true, force: true }); }
	writeFileSync(join(options.outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
	try {
		if (process.argv.length === 3 && process.argv[2] === "--help") console.log(usage);
		else {
			const options = parseLatencyArguments(process.argv.slice(2));
			const report = options.worker ? await worker(options) : await runLatency(options);
			if (!options.worker) console.log(JSON.stringify({ passed: report.passed, strategy: options.strategy, writer: options.writer, counts: report.counts, calls: report.callTotals?.calls, pathCounts: report.pathCounts }));
			if (options.worker ? !report.completed : !report.passed) process.exitCode = 1;
		}
	} catch (error) { console.error(error.message === usage ? usage : safeError(error)); process.exitCode = error.message === usage ? 2 : 1; }
}
