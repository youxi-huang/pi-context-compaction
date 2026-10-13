import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { inspectOfficialPi } from "./context-memory-preview-stock-install.mjs";

// A finite, network-denied experiment for the bridge-only installer. This is
// neither production wiring nor evidence of intake, projection or durability.
export const GUARD_LIMITS = Object.freeze({ workers: 21, workerMs: 15_000, warmingMs: 20_000, wallMs: 180_000, providerCalls: 8, caseProviderCalls: 2, events: 48, reportBytes: 131_072, outputBytes: 65_536, sourceBytes: 1_048_576 });
export const GUARD_CASES = Object.freeze(["legacy", "disabled-legacy", "input", "active-input", "disabled-input", "reader-error", "context", "context_with_system", "before_provider_request", "manual-compact", "threshold-compact", "overflow-compact", "tree", "tree-summary", "fork-before", "fork-at", "warming", "warming-legacy", "warming-order", "recover", "recover-legacy"]);
const EVENTS = Object.freeze(["input", "context", "context_with_system", "before_provider_request", "session_before_compact", "session_before_tree", "session_before_fork", "cache_warming_decision"]);
const CHECKS = Object.freeze(["baseline", "loaded", "disabled", "handled", "activeAbort", "cancelled", "hookObserved", "noDispatch", "noCompaction", "leafUnchanged", "noForkFile", "warmingScheduled", "warmingStopped", "warmingReachable", "warmDecision", "lastOverrideWins", "commandBeforeInput", "mutationBlocked", "mutationReachable", "markerUnchanged", "reasonMatched", "ownershipState"]);
const CODES = Object.freeze(["GUARDS_RUNNING", "GUARDS_OK", "GUARDS_EXPECTATION", "GUARDS_WORKER_ERROR", "GUARDS_WORKER_TIMEOUT", "GUARDS_REPORT_INVALID", "GUARDS_TOTAL_DEADLINE", "GUARDS_PROVIDER_LIMIT", "GUARDS_OUTPUT_LIMIT", "GUARDS_SOURCE_LIMIT", "GUARDS_SOURCE_GRAPH", "GUARDS_BRIDGE_UNAVAILABLE", "GUARDS_ABORTED"]);
const MODES = Object.freeze(["deterministic-stub", "bridge"]);
const repository = fileURLToPath(new URL("../", import.meta.url));
const scriptFile = fileURLToPath(import.meta.url);
const harnessSource = readFileSync(scriptFile);
const sourceRoot = "packages/coding-agent/src/extensions/context-memory/";
const guardsFile = `${sourceRoot}preview/authority-bridge-guards.ts`;
const bridgeFile = `${sourceRoot}preview/authority-bridge.ts`;
const HOST_INPUTS = Object.freeze(["pi-coding-agent/dist/core/sdk.js", "pi-coding-agent/dist/core/extensions/runner.js", "pi-coding-agent/dist/core/agent-session.js", "pi-coding-agent/dist/core/agent-session-runtime.js", "pi-coding-agent/dist/core/model-runtime.js", "pi-coding-agent/dist/core/cache-warmer.js", "pi-coding-agent/dist/core/session-manager.js", "pi-agent-core/dist/agent-loop.js", "pi-agent-core/dist/agent.js", "pi-ai/dist/api/openai-completions.js"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const requireCondition = (condition, code = "GUARDS_EXPECTATION") => { if (!condition) throw new Error(code); };
const errorCode = (error) => CODES.includes(error?.message) ? error.message : "GUARDS_WORKER_ERROR";
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const count = (value, cap) => Number.isSafeInteger(value) && value >= 0 && value <= cap;

export function guardEnvironment(agentDir) {
	return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", CI: "1", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", EVAL_PROVIDER_MODE: "scripted", EVAL_MODEL_CALL_BUDGET: "0", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
}

export function outsideRepository(file, root = repository) {
	const target = resolve(file);
	const from = relative(realpathSync(root), target);
	requireCondition(from.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(from), "GUARDS_REPORT_INVALID");
	for (let parent = target; ; parent = dirname(parent)) {
		if (existsSync(parent)) requireCondition(!lstatSync(parent).isSymbolicLink(), "GUARDS_REPORT_INVALID");
		if (dirname(parent) === parent) break;
	}
	return target;
}

export function parseGuardArguments(args) {
	const options = { reader: "deterministic-stub" };
	const seen = new Set();
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		requireCondition(["--stock-root", "--output-dir", "--reader"].includes(flag) && !seen.has(flag) && args[index + 1] && !args[index + 1].startsWith("--"), "GUARDS_REPORT_INVALID");
		seen.add(flag);
		const key = flag === "--stock-root" ? "stockRoot" : flag === "--output-dir" ? "outputDir" : "reader";
		options[key] = key === "reader" ? args[++index] : resolve(args[++index]);
	}
	requireCondition(options.stockRoot && options.outputDir && MODES.includes(options.reader), "GUARDS_REPORT_INVALID");
	options.outputDir = outsideRepository(options.outputDir);
	return options;
}

export function safeGuardResult(value) {
	requireCondition(exactKeys(value, ["case", "readerMode", "readerExposure", "ownershipFixture", "ownershipState", "classification", "stage", "state", "code", "provider", "events", "checks", "mutations"]), "GUARDS_REPORT_INVALID");
	requireCondition(GUARD_CASES.includes(value.case) && MODES.includes(value.readerMode) && ["running", "passed", "failed"].includes(value.state) && CODES.includes(value.code), "GUARDS_REPORT_INVALID");
	requireCondition(["all-events", "target-hook", "after-first-request"].includes(value.readerExposure) && ["none", "synthetic-policy", "active", "pending-with-unapproved-history"].includes(value.ownershipFixture) && ["refusal", "legacy-control", "unsupported-ordering"].includes(value.classification), "GUARDS_REPORT_INVALID");
	requireCondition(["not-read", "legacy", "pending", "unsealed", "active", "unsupported", "tampered"].includes(value.ownershipState) && ["load", "provider", "reader", "session", "operation", "checks", "complete"].includes(value.stage), "GUARDS_REPORT_INVALID");
	requireCondition(exactKeys(value.provider, ["adapterEntries", "fetchDispatches", "abortedFetches"]) && Object.values(value.provider).every((n) => count(n, 32)), "GUARDS_REPORT_INVALID");
	requireCondition(value.provider.fetchDispatches <= GUARD_LIMITS.caseProviderCalls, "GUARDS_REPORT_INVALID");
	requireCondition(Array.isArray(value.events) && value.events.length <= GUARD_LIMITS.events, "GUARDS_REPORT_INVALID");
	for (const event of value.events) {
		requireCondition(exactKeys(event, ["event", "denied", "active", "aborted", "handled", "cancelled", "stopped"]) && EVENTS.includes(event.event) && Object.entries(event).every(([key, v]) => key === "event" || typeof v === "boolean"), "GUARDS_REPORT_INVALID");
	}
	requireCondition(value.checks && typeof value.checks === "object" && !Array.isArray(value.checks) && Object.entries(value.checks).every(([key, v]) => CHECKS.includes(key) && typeof v === "boolean") && count(value.mutations, 2), "GUARDS_REPORT_INVALID");
	if (value.state === "passed") requireCondition(value.code === "GUARDS_OK" && Object.keys(value.checks).length > 0 && Object.values(value.checks).every(Boolean), "GUARDS_REPORT_INVALID");
	const text = JSON.stringify(value);
	requireCondition(Buffer.byteLength(text) <= GUARD_LIMITS.reportBytes, "GUARDS_OUTPUT_LIMIT");
	return JSON.parse(text);
}

export async function buildGuardBundle(directory, { root = repository, reader = "deterministic-stub" } = {}) {
	requireCondition(MODES.includes(reader), "GUARDS_REPORT_INVALID");
	if (reader === "bridge") requireCondition(existsSync(join(root, bridgeFile)), "GUARDS_BRIDGE_UNAVAILABLE");
	const snapshot = new Map();
	let bytes = 0;
	const compiled = await build({
		absWorkingDir: root,
		stdin: { contents: `export { installAuthorityBridgeGuards, assertLegacyAuthorityOperation } from "./${guardsFile}";${reader === "bridge" ? ` export { PreviewAuthorityBridge, authoritySourceHash } from "./${bridgeFile}";` : ""}`, resolveDir: root },
		bundle: true, write: false, metafile: true, format: "esm", platform: "node", target: "node22", packages: "external", tsconfigRaw: { compilerOptions: {} }, sourcemap: false, legalComments: "none", outfile: "guards.mjs", logLevel: "silent",
		plugins: [{ name: "authority-guards-source-snapshot", setup(api) {
			api.onLoad({ filter: /\.ts$/ }, ({ path }) => {
				const file = relative(root, realpathSync(path)).split("\\").join("/");
				requireCondition(file.startsWith(sourceRoot) && !file.includes("../"), "GUARDS_SOURCE_GRAPH");
				let source = snapshot.get(file);
				if (!source) {
					const data = readFileSync(path);
					bytes += data.length;
					requireCondition(bytes <= GUARD_LIMITS.sourceBytes, "GUARDS_SOURCE_LIMIT");
					source = { bytes: data, file, sha256: sha256(data) };
					snapshot.set(file, source);
				}
				return { contents: source.bytes, loader: "ts", resolveDir: dirname(path) };
			});
		} }],
	});
	requireCondition(compiled.outputFiles.length === 1 && snapshot.has(guardsFile), "GUARDS_SOURCE_GRAPH");
	const sources = [...snapshot.values()].sort((a, b) => a.file.localeCompare(b.file));
	const actual = Object.keys(compiled.metafile.inputs).filter((file) => file !== "<stdin>").sort();
	requireCondition(JSON.stringify(actual) === JSON.stringify(sources.map((source) => source.file).sort()), "GUARDS_SOURCE_GRAPH");
	for (const source of sources) requireCondition(sha256(readFileSync(join(root, source.file))) === source.sha256, "GUARDS_SOURCE_GRAPH");
	const bundle = compiled.outputFiles[0].contents;
	const bundleFile = join(directory, "guards.mjs");
	writeFileSync(bundleFile, bundle, { flag: "wx", mode: 0o600 });
	return { bundleFile, readerMode: reader, sourceGraphSha256: sha256(Buffer.concat(sources.flatMap((source) => [Buffer.from(`${source.file}\0`), source.bytes, Buffer.from("\0")]))), bundleSha256: sha256(bundle), sources: sources.map(({ file, sha256: hash, bytes: data }) => ({ file, sha256: hash, bytes: data.length })) };
}

function emptyResult(caseName, readerMode) {
	const clean = ["legacy", "disabled-legacy", "warming-legacy", "recover-legacy"].includes(caseName);
	return { case: caseName, readerMode, readerExposure: ["context", "context_with_system", "before_provider_request"].includes(caseName) ? "target-hook" : ["threshold-compact", "overflow-compact", "warming"].includes(caseName) ? "after-first-request" : "all-events", ownershipFixture: clean ? "none" : readerMode === "deterministic-stub" ? "synthetic-policy" : caseName === "active-input" ? "active" : "pending-with-unapproved-history", ownershipState: "not-read", classification: caseName === "warming-order" ? "unsupported-ordering" : clean ? "legacy-control" : "refusal", stage: "load", state: "running", code: "GUARDS_RUNNING", provider: { adapterEntries: 0, fetchDispatches: 0, abortedFetches: 0 }, events: [], checks: {}, mutations: 0 };
}

export async function runGuardHarness(options, dependencies = {}) {
	const inspect = dependencies.inspect ?? inspectOfficialPi;
	const execute = dependencies.execute ?? spawnSync;
	const compile = dependencies.compile ?? buildGuardBundle;
	const clock = dependencies.clock ?? Date.now;
	const outputDir = outsideRepository(options.outputDir);
	mkdirSync(outputDir, { recursive: true });
	requireCondition(readdirSync(outputDir).length === 0, "GUARDS_REPORT_INVALID");
	writeFileSync(join(outputDir, "owner"), "authority-guards\n", { flag: "wx", mode: 0o600 });
	const report = { version: 1, kind: "official-sdk-authority-guards", state: "running", code: "GUARDS_RUNNING", readerMode: options.reader, claim: "synthetic transport/public-event refusal only; no production wiring, intake, projection, authentic approval or persistence claim", scope: "single reviewed prototype extension; target-hook/after-first-request rows deliberately defer reader exposure to isolate mechanisms", disabledFixture: "installer runs before fixture enabled:false return; not production package integration", recoveryFixture: "slash-command wrapper around numeric/dummy marker mutation; not PreviewFailureStore recovery", limitation: "warming last override wins; warming-order verifies an unsupported competing override, not refusal", transport: "official openai-completions adapter with in-memory fetch; sockets denied", limits: GUARD_LIMITS, scriptSha256: sha256(harnessSource), cases: [] };
	const persist = () => { const text = JSON.stringify(report, null, 2); requireCondition(Buffer.byteLength(text) <= GUARD_LIMITS.reportBytes, "GUARDS_OUTPUT_LIMIT"); writeFileSync(join(outputDir, "report.json"), text, { mode: 0o600 }); };
	const start = clock();
	let directory;
	let abortRequested = false;
	const abort = () => { abortRequested = true; };
	process.once("SIGINT", abort); process.once("SIGTERM", abort);
	try {
		report.host = inspect(options.stockRoot, "1.1.0");
		if (!dependencies.inspect) report.hostInputs = HOST_INPUTS.map((file) => ({ file, sha256: sha256(readFileSync(join(options.stockRoot, "node_modules/@earendil-works", file))) }));
		directory = mkdtempSync(join(tmpdir(), "pi-authority-guards-"));
		for (let parent = dirname(directory); ; parent = dirname(parent)) { requireCondition(!existsSync(join(parent, "package.json")), "GUARDS_SOURCE_GRAPH"); if (dirname(parent) === parent) break; }
		const provenance = await compile(directory, { reader: options.reader });
		const { bundleFile, ...safeProvenance } = provenance;
		report.prototype = safeProvenance;
		// Children always load frozen copies, even if a developer changes the
		// harness between cases. The only rewritten import is its build dependency.
		const workerScripts = join(directory, "scripts"); mkdirSync(workerScripts);
		const anchor = '\nimport { build } from "esbuild";\n';
		const source = harnessSource.toString("utf8");
		requireCondition(source.split(anchor).length === 2, "GUARDS_SOURCE_GRAPH");
		const workerSource = source.replace(anchor, `\nimport { build } from ${JSON.stringify(import.meta.resolve("esbuild"))};\n`);
		const workerScript = join(workerScripts, "context-memory-authority-guards.mjs");
		writeFileSync(workerScript, workerSource, { flag: "wx", mode: 0o600 });
		const inspector = readFileSync(new URL("./context-memory-preview-stock-install.mjs", import.meta.url));
		writeFileSync(join(workerScripts, "context-memory-preview-stock-install.mjs"), inspector, { flag: "wx", mode: 0o600 });
		const networkPolicy = readFileSync(join(repository, "eval/deny-network.mjs"));
		const networkFile = join(directory, "deny-network.mjs"); writeFileSync(networkFile, networkPolicy, { flag: "wx", mode: 0o600 });
		report.workerHarnessSha256 = sha256(workerSource); report.inspectorSha256 = sha256(inspector); report.networkPolicySha256 = sha256(networkPolicy);
		persist();
		let calls = 0;
		for (const caseName of GUARD_CASES) {
			await new Promise((done) => setImmediate(done));
			requireCondition(!abortRequested, "GUARDS_ABORTED");
			const remaining = GUARD_LIMITS.wallMs - (clock() - start);
			requireCondition(remaining > 0, "GUARDS_TOTAL_DEADLINE");
			const caseEvidence = join(outputDir, caseName);
			const caseWork = join(directory, caseName);
			mkdirSync(caseEvidence); mkdirSync(caseWork);
			writeFileSync(join(caseEvidence, "result.json"), JSON.stringify(emptyResult(caseName, options.reader)), { flag: "wx", mode: 0o600 });
			const parameters = ["--import", networkFile, workerScript, "--worker", resolve(options.stockRoot), bundleFile, caseWork, caseEvidence, caseName, options.reader, String(GUARD_LIMITS.providerCalls - calls)];
			const result = execute(process.execPath, parameters, { cwd: caseWork, env: guardEnvironment(join(caseWork, "agent")), timeout: Math.min(remaining, caseName.startsWith("warming") ? GUARD_LIMITS.warmingMs : GUARD_LIMITS.workerMs), maxBuffer: GUARD_LIMITS.outputBytes, encoding: "utf8" });
			// Deliver pending OS signals after at most one bounded sync worker.
			await new Promise((done) => setImmediate(done));
			let observations;
			try {
				const stat = lstatSync(join(caseEvidence, "result.json"));
				requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= GUARD_LIMITS.reportBytes, "GUARDS_REPORT_INVALID");
				observations = safeGuardResult(JSON.parse(readFileSync(join(caseEvidence, "result.json"), "utf8")));
				requireCondition(observations.case === caseName && observations.readerMode === options.reader, "GUARDS_REPORT_INVALID");
			}
			catch {
				observations = { ...emptyResult(caseName, options.reader), state: "failed", code: "GUARDS_REPORT_INVALID" };
				rmSync(join(caseEvidence, "result.json"), { recursive: true, force: true });
				writeFileSync(join(caseEvidence, "result.json"), JSON.stringify(observations), { flag: "wx", mode: 0o600 });
			}
			const processRecord = { exitCode: Number.isInteger(result.status) ? result.status : null, killed: Boolean(result.signal || result.error), stdoutBytes: Buffer.byteLength(result.stdout ?? ""), stdoutSha256: sha256(result.stdout ?? ""), stderrBytes: Buffer.byteLength(result.stderr ?? ""), stderrSha256: sha256(result.stderr ?? ""), commandSha256: sha256(JSON.stringify([process.execPath, ...parameters])) };
			calls += observations.provider.fetchDispatches;
			report.cases.push({ ...observations, process: processRecord });
			report.providerDispatches = calls;
			persist();
			requireCondition(!abortRequested, "GUARDS_ABORTED");
			requireCondition(calls <= GUARD_LIMITS.providerCalls, "GUARDS_PROVIDER_LIMIT");
			requireCondition(result.status === 0 && !result.error && observations.state === "passed", result.error?.code === "ETIMEDOUT" ? "GUARDS_WORKER_TIMEOUT" : "GUARDS_WORKER_ERROR");
		}
		requireCondition(report.cases.length === GUARD_LIMITS.workers, "GUARDS_EXPECTATION");
		if (report.hostInputs) {
			report.postrunHostInputsIdentical = report.hostInputs.every(({ file, sha256: expected }) => sha256(readFileSync(join(options.stockRoot, "node_modules/@earendil-works", file))) === expected);
			requireCondition(report.postrunHostInputsIdentical, "GUARDS_SOURCE_GRAPH");
			requireCondition(JSON.stringify(inspect(options.stockRoot, "1.1.0")) === JSON.stringify(report.host), "GUARDS_SOURCE_GRAPH");
		}
		report.state = "passed"; report.code = "GUARDS_OK";
	} catch (error) { report.state = "failed"; report.code = errorCode(error); }
	finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); if (directory) rmSync(directory, { recursive: true, force: true }); persist(); }
	writeFileSync(join(outputDir, "report.sha256"), `${sha256(readFileSync(join(outputDir, "report.json")))}\n`, { mode: 0o600 });
	return report;
}

async function runWorker(stockRoot, bundleFile, directory, evidence, caseName, readerMode, admissionBudget) {
	requireCondition(GUARD_CASES.includes(caseName) && MODES.includes(readerMode), "GUARDS_REPORT_INVALID");
	const remainingCalls = Number(admissionBudget);
	requireCondition(count(remainingCalls, GUARD_LIMITS.providerCalls), "GUARDS_REPORT_INVALID");
	const result = emptyResult(caseName, readerMode);
	const persist = () => writeFileSync(join(evidence, "result.json"), JSON.stringify(safeGuardResult(result)), { mode: 0o600 });
	let host;
	try {
		inspectOfficialPi(stockRoot, "1.1.0");
		const sdkRoot = join(stockRoot, "node_modules/@earendil-works");
		const sdk = await import(pathToFileURL(join(sdkRoot, "pi-coding-agent/dist/index.js")).href);
		const adapter = await import(pathToFileURL(join(sdkRoot, "pi-ai/dist/api/openai-completions.js")).href);
		const guards = await import(pathToFileURL(bundleFile).href);
		requireCondition(sdk.VERSION === "1.1.0", "GUARDS_EXPECTATION");
		result.stage = "provider"; persist();
		const cwd = join(directory, "cwd"), agentDir = join(directory, "agent"), sessionDir = join(directory, "sessions");
		for (const folder of [cwd, agentDir, sessionDir]) mkdirSync(folder, { recursive: true });
		const disabled = caseName.startsWith("disabled-");
		writeFileSync(join(agentDir, "pi-context-memory.json"), JSON.stringify({ enabled: !disabled }));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: caseName.endsWith("-compact") && caseName !== "manual-compact", keepRecentTokens: 0, reserveTokens: 16384 }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: ["warming", "warming-legacy"].includes(caseName) ? "idle" : "off", defaultTools: [] }));
		const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
		const warming = ["warming", "warming-legacy"].includes(caseName);
		const model = { id: "synthetic-guards", name: "Synthetic guards", provider: "synthetic-guards", api: "openai-completions", baseUrl: "https://offline.invalid/v1", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, compat: { supportsUsageInStreaming: true }, cost: { input: warming ? 100000 : 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(warming ? { promptCache: { short: 11, long: 11 } } : {}) };
		const transport = async (_request, options) => {
			if (options?.signal?.aborted) { result.provider.abortedFetches++; throw new DOMException("synthetic abort", "AbortError"); }
			requireCondition(result.provider.fetchDispatches < Math.min(GUARD_LIMITS.caseProviderCalls, remainingCalls), "GUARDS_PROVIDER_LIMIT");
			result.provider.fetchDispatches++;
			persist();
			if (caseName === "overflow-compact") return new Response(JSON.stringify({ error: { message: "maximum context length exceeded", type: "invalid_request_error", code: "context_length_exceeded" } }), { status: 400, headers: { "content-type": "application/json" } });
			const chunks = [
				{ id: "synthetic", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-ok" }, finish_reason: null }] },
				{ id: "synthetic", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: caseName === "threshold-compact" ? 120000 : 20, completion_tokens: 2, total_tokens: caseName === "threshold-compact" ? 120002 : 22 } },
			];
			return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		modelRuntime.registerProvider(model.provider, { api: model.api, apiKey: "synthetic-guards-only", models: [model], streamSimple: (selected, context, options) => {
			requireCondition(++result.provider.adapterEntries <= 32, "GUARDS_PROVIDER_LIMIT");
			return adapter.streamSimple(selected, context, { ...options, fetch: transport });
		} });
		let deny = !["legacy", "disabled-legacy", "threshold-compact", "overflow-compact", "warming", "warming-legacy", "recover-legacy"].includes(caseName);
		let phase;
		let denied = false;
		let commandCalls = 0, inputCalls = 0;
		let bridge;
		result.stage = "reader"; persist();
		if (readerMode === "bridge") {
			// Exact primitive API is deliberately required; never silently substitute a stub.
			requireCondition(typeof guards.PreviewAuthorityBridge === "function", "GUARDS_BRIDGE_UNAVAILABLE");
			bridge = new guards.PreviewAuthorityBridge(agentDir, { enabled: true });
		}
		const reader = { assertLegacy(session, action) {
			if (caseName === "reader-error") { denied = true; throw new Error("synthetic private reader failure"); }
			const activeCase = ["context", "context_with_system", "before_provider_request"].includes(caseName);
			const refuse = activeCase ? phase === caseName : deny;
			if (refuse) {
				denied = true;
				if (bridge) { result.ownershipState = bridge.inspect(session).state; bridge.assertLegacy(session, action); }
				else throw new Error("synthetic ownership");
			} else if (bridge && result.readerExposure === "all-events") bridge.assertLegacy(session, action);
		} };
		const marker = join(agentDir, "synthetic-recovery-marker");
		writeFileSync(marker, "synthetic-unchanged");
		const markerBefore = sha256(readFileSync(marker));
		let compactReason;
		let warmAction;
		const factory = (pi) => {
			const observed = { on(event, handler) { return pi.on(event, async (value, ctx) => {
				phase = event; denied = false;
				const active = Boolean(ctx.signal);
				if (event === "session_before_compact") compactReason = value.reason;
				if (event === "cache_warming_decision") warmAction = value.action;
				const answer = await handler(value, ctx);
				requireCondition(result.events.length < GUARD_LIMITS.events, "GUARDS_OUTPUT_LIMIT");
				result.events.push({ event, denied, active, aborted: Boolean(ctx.signal?.aborted), handled: answer?.action === "handled", cancelled: answer?.cancel === true, stopped: answer?.action === "stop" });
				persist(); return answer;
			}); } };
			guards.installAuthorityBridgeGuards(observed, reader);
			pi.registerCommand("compaction-recover", { description: "Synthetic guarded operation", handler: async (_args, ctx) => {
				commandCalls++;
				try { guards.assertLegacyAuthorityOperation(reader, ctx, "recover"); } catch { return; }
				result.mutations++; writeFileSync(marker, "synthetic-mutated"); persist();
			} });
			pi.on("input", () => { inputCalls++; });
			pi.on("message_end", (event) => { if (event.message.role === "assistant" && ["threshold-compact", "overflow-compact"].includes(caseName)) deny = true; });
			if (caseName === "warming-order") pi.on("cache_warming_decision", () => ({ action: "warm" }));
			if (disabled) return;
		};
		const manager = sdk.SessionManager.create(cwd, sessionDir);
		result.stage = "session"; persist();
		const reviewed = { role: "user", content: [{ type: "text", text: "synthetic fixture" }], timestamp: 1 };
		let token;
		if (bridge && result.ownershipFixture !== "none") {
			token = bridge.beginEnrollment(manager, guards.authoritySourceHash(reviewed));
			if (caseName === "active-input") manager.appendCustomEntry(token.customType, token.data);
			// Other rows deliberately follow a real pending barrier with unapproved
			// history: the primitive must classify owned/tampered and still refuse.
		}
		const firstUser = manager.appendMessage(reviewed);
		let assistant;
		if (bridge && caseName === "active-input") {
			bridge.confirmSource(manager, token);
			const seal = bridge.createSealClaim(manager, token);
			const id = manager.appendCustomEntry(seal.customType, seal.data);
			bridge.confirmSeal(manager, token, id);
		} else assistant = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "synthetic complete" }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2, usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 22, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		// Enrollment is disabled in this recognizer; ownership must still refuse.
		if (bridge) { bridge = new guards.PreviewAuthorityBridge(agentDir); result.ownershipState = bridge.inspect(manager).state; }
		const createRuntime = async (options) => {
			const services = await sdk.createAgentSessionServices({ cwd, agentDir, modelRuntime, resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [{ name: "authority-guards-offline-prototype", factory }] } });
			requireCondition(services.diagnostics.length === 0);
			const created = await sdk.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, model, thinkingLevel: "off", noTools: "all" });
			requireCondition(created.extensionsResult.errors.length === 0 && created.extensionsResult.extensions.length === 1);
			return { ...created, services, diagnostics: services.diagnostics };
		};
		host = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: manager });
		let unexpectedDiagnostics = 0;
		const bind = (session) => session.bindExtensions({ mode: "print", onError: () => { unexpectedDiagnostics++; }, commandContextActions: { fork: (id, options) => host.fork(id, options), switchSession: (file, options) => host.switchSession(file, options), newSession: (options) => host.newSession(options) } });
		host.setRebindSession(bind); await bind(host.session);
		result.checks.loaded = true;
		if (bridge) {
			result.ownershipState = bridge.inspect(manager).state;
			result.checks.ownershipState = result.ownershipState === (result.ownershipFixture === "none" ? "legacy" : caseName === "active-input" ? "active" : "tampered");
			requireCondition(result.checks.ownershipState);
		}
		if (disabled) result.checks.disabled = JSON.parse(readFileSync(join(agentDir, "pi-context-memory.json"))).enabled === false;
		const beforeLeaf = manager.getLeafId(), beforeFiles = readdirSync(sessionDir).length;
		result.stage = "operation"; persist();
		if (["legacy", "disabled-legacy"].includes(caseName)) {
			await host.session.prompt("synthetic baseline");
			result.checks.baseline = result.provider.fetchDispatches === 1 && host.session.agent.state.messages.at(-1)?.stopReason === "stop";
		} else if (["input", "active-input", "disabled-input", "reader-error"].includes(caseName)) {
			let disposition;
			await host.session.prompt("synthetic blocked", { preflightResult: (state) => { disposition = state; } });
			result.checks.handled = disposition === "handled" && result.events.some((event) => event.event === "input" && event.handled);
			result.checks.leafUnchanged = manager.getLeafId() === beforeLeaf;
			result.checks.noDispatch = result.provider.fetchDispatches === 0;
		} else if (["context", "context_with_system", "before_provider_request"].includes(caseName)) {
			// Public Agent API intentionally bypasses input; the actual SDK callbacks remain installed.
			await host.session.agent.prompt("synthetic active guard");
			result.checks.activeAbort = result.events.some((event) => event.event === caseName && event.denied && event.active && event.aborted);
			result.checks.noDispatch = result.provider.fetchDispatches === 0;
		} else if (caseName === "manual-compact") {
			try { await host.session.compact(); } catch {}
			result.checks.cancelled = result.events.some((event) => event.event === "session_before_compact" && event.cancelled);
			result.checks.reasonMatched = compactReason === "manual";
			result.checks.noDispatch = result.provider.fetchDispatches === 0;
			result.checks.noCompaction = !manager.getEntries().some((entry) => entry.type === "compaction");
		} else if (["threshold-compact", "overflow-compact"].includes(caseName)) {
			await host.session.prompt("synthetic native boundary"); await host.session.waitForIdle();
			result.checks.cancelled = result.events.some((event) => event.event === "session_before_compact" && event.cancelled);
			result.checks.reasonMatched = compactReason === (caseName === "threshold-compact" ? "threshold" : "overflow");
			result.checks.noDispatch = result.provider.fetchDispatches === 1;
			result.checks.noCompaction = !manager.getEntries().some((entry) => entry.type === "compaction");
		} else if (["tree", "tree-summary"].includes(caseName)) {
			const answer = await host.session.navigateTree(firstUser, { summarize: caseName === "tree-summary" });
			result.checks.cancelled = answer.cancelled === true && result.events.some((event) => event.event === "session_before_tree" && event.cancelled);
			result.checks.leafUnchanged = manager.getLeafId() === beforeLeaf;
			result.checks.noDispatch = result.provider.fetchDispatches === 0;
		} else if (caseName.startsWith("fork-")) {
			const answer = await host.fork(caseName === "fork-before" ? firstUser : assistant, { position: caseName === "fork-before" ? "before" : "at" });
			result.checks.cancelled = answer.cancelled === true && result.events.some((event) => event.event === "session_before_fork" && event.cancelled);
			result.checks.noForkFile = readdirSync(sessionDir).length === beforeFiles;
			result.checks.leafUnchanged = host.session.sessionManager.getLeafId() === beforeLeaf;
			result.checks.noDispatch = result.provider.fetchDispatches === 0;
		} else if (warming) {
			await host.session.prompt("synthetic warm baseline");
			result.checks.baseline = result.provider.fetchDispatches === 1;
			result.checks.warmingScheduled = host.session.cacheWarmingStatus?.state === "scheduled";
			if (caseName === "warming") deny = true;
			for (let tick = 0; tick < 80 && !result.events.some((event) => event.event === "cache_warming_decision"); tick++) await new Promise((done) => setTimeout(done, 100));
			result.checks.warmDecision = warmAction === "warm";
			if (caseName === "warming") {
				result.checks.warmingStopped = result.events.some((event) => event.event === "cache_warming_decision" && event.stopped) && host.session.cacheWarmingStatus?.reason === "stopped by extension";
				result.checks.noDispatch = result.provider.fetchDispatches === 1;
			} else {
				for (let tick = 0; tick < 20 && result.provider.fetchDispatches < 2; tick++) await new Promise((done) => setTimeout(done, 10));
				result.checks.warmingReachable = result.provider.fetchDispatches === 2 && manager.getEntries().some((entry) => entry.type === "usage" && entry.kind === "cache_warm");
			}
		} else if (caseName === "warming-order") {
			const action = await host.session.extensionRunner.emitCacheWarmingDecision({ type: "cache_warming_decision", action: "warm", warmCost: 0, missCost: 100, continuationProbability: 1 });
			result.checks.lastOverrideWins = action === "warm" && result.events.some((event) => event.event === "cache_warming_decision" && event.stopped);
			result.checks.noDispatch = result.provider.fetchDispatches === 0;
		} else if (caseName.startsWith("recover")) {
			await host.session.prompt("/compaction-recover");
			result.checks.commandBeforeInput = commandCalls === 1 && inputCalls === 0 && !result.events.some((event) => event.event === "input");
			result.checks[caseName === "recover" ? "mutationBlocked" : "mutationReachable"] = result.mutations === (caseName === "recover" ? 0 : 1);
			result.checks.noDispatch = result.provider.fetchDispatches === 0;
		}
		if (caseName !== "recover-legacy") result.checks.markerUnchanged = sha256(readFileSync(marker)) === markerBefore;
		result.stage = "checks"; persist();
		requireCondition(unexpectedDiagnostics === 0);
		requireCondition(Object.values(result.checks).every(Boolean));
		result.state = "passed"; result.code = "GUARDS_OK"; result.stage = "complete";
	} catch (error) { result.state = "failed"; result.code = errorCode(error); }
	finally { host?.session.dispose(); persist(); }
	return result;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptFile) {
	if (process.argv[2] === "--worker") {
		try { const report = await runWorker(...process.argv.slice(3)); process.exitCode = report.state === "passed" ? 0 : 1; }
		catch { process.exitCode = 1; }
	} else {
		try { const report = await runGuardHarness(parseGuardArguments(process.argv.slice(2))); process.stdout.write(`${report.state} ${report.code}\n`); process.exitCode = report.state === "passed" ? 0 : 1; }
		catch (error) { process.stderr.write(`${errorCode(error)}\n`); process.exitCode = 1; }
	}
}
