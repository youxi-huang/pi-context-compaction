import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectOfficialPi } from "./context-memory-preview-stock-install.mjs";
import { assertProfileVersion, gradeScenarioAcceptance } from "./context-memory-preview-acceptance-profile.mjs";

// Default-settings scenarios for the stock-Pi preview, each beside a control run without the extension.
// Uses only an official npm Pi installation and a loopback mock provider. Never contacts a model service.
//
// Every check states the intended behavior. Checks listed in KNOWN_GAPS are not provided by the current
// preview: they are reported and do not fail the run. A listed check that starts passing fails the run
// until it is removed from KNOWN_GAPS, so a fix cannot land without becoming a required regression.
const KNOWN_GAPS = new Set([]);

const CASES = [
	{ name: "documented-first-compaction", variants: ["extension"] },
	{ name: "invalid-config", variants: ["extension"] },
	{ name: "provider-retry", variants: ["extension", "control"] },
	{ name: "provider-connection-drop", variants: ["extension", "control"] },
	{ name: "provider-partial-drop", variants: ["extension", "control"] },
	{ name: "provider-repeated-retry", variants: ["extension", "control"] },
	{ name: "provider-first-turn-retry", variants: ["extension", "control"] },
	{ name: "provider-retry-exhausted", variants: ["extension", "control"] },
	{ name: "legacy-retry-marker", variants: ["extension"] },
	{ name: "context-overflow", variants: ["extension", "control"] },
	{ name: "threshold", variants: ["extension", "control"] },
	{ name: "image-input", variants: ["extension", "control"] },
	{ name: "protected-image", variants: ["extension"] },
	{ name: "native-checkpoint-session", variants: ["extension"] },
	{ name: "enrolled-then-native", variants: ["extension"] },
	{ name: "protected-then-native", variants: ["extension"] },
	{ name: "in-memory-session", variants: ["extension", "control"] },
	{ name: "other-pi-version", variants: ["extension", "control"], otherHost: true },
	{ name: "failed-compaction-notices", variants: ["extension"] },
	{ name: "long-session-overhead", variants: ["extension"], timeoutMs: 1_200_000 },
];

const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
function argument(name, fallback) {
	const index = args.indexOf(name);
	if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) return args[index + 1];
	if (index >= 0) throw new Error(`Missing value for ${name}`);
	if (fallback !== undefined) return fallback;
	throw new Error(
		`Missing ${name}. Usage: node ${script} --package-dir <candidate> --stock-root <official npm installation> --output-dir <evidence> [--other-stock-root <another Pi version>] [--perf-checkpoints 20] [--only <case>] [--acceptance-profile <profile>]`,
	);
}
const packageDir = resolve(argument("--package-dir"));
const stockRoot = resolve(argument("--stock-root"));
const outputDir = resolve(argument("--output-dir"));
const workerCase = argument("--worker", "");

function environment(agentDir) {
	const value = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: "C.UTF-8",
		CI: "1",
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "0", // Loopback HTTP requires transport; no catalog or provider network is used.
		PI_TELEMETRY: "0",
		PI_SKIP_VERSION_CHECK: "1",
	};
	if (process.env.SystemRoot) value.SystemRoot = process.env.SystemRoot;
	return value;
}

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

// ---------------------------------------------------------------------------------------------------------
// Worker: one case, one variant, one process.
// ---------------------------------------------------------------------------------------------------------

async function worker() {
	const variant = argument("--variant");
	const withExtension = variant === "extension";
	const caseDir = join(outputDir, "cases", `${workerCase}--${variant}`);
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	mkdirSync(agentDir, { recursive: true });

	// The SDK has no UI here, so the extension's notices go to the console.
	const notices = [];
	// Command output (status JSON, doctor text) is collected separately while a command runs.
	let commandOutput;
	for (const level of ["log", "warn", "error"]) {
		const original = console[level].bind(console);
		console[level] = (...parts) => {
			const text = parts.map(String).join(" ");
			if (commandOutput) commandOutput.push(text);
			else if (text.includes("context-memory preview")) notices.push(text);
			else original(...parts);
		};
	}

	const stockPackage = join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent");
	const stock = await import(pathToFileURL(join(stockPackage, "dist", "index.js")).href);
	const piVersion = JSON.parse(readFileSync(join(stockPackage, "package.json"), "utf8")).version;

	const SOURCE_TEXT = "Use port 4317. Do not deploy this synthetic service. Continue checking it locally.";
	const PARTIAL_REPLY = "Unfinished synthetic response before the connection dropped.";
	// About 31k estimated tokens: enough later history for Pi's default 20k keep-recent gate.
	const BIG_LOG = `Here is the local check log:\n${Array.from({ length: 2500 }, (_, i) => `log ${String(i).padStart(5, "0")}: local check ok, port 4317 healthy`).join("\n")}`;
	const PNG =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

	// ----- loopback provider -----
	const requests = [];
	let plan = () => ({ kind: "ok" });
	let writerMode = "good";
	let manager;
	function sourceId() {
		return manager
			?.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes("Do not deploy"),
			)?.id;
	}
	function note() {
		const id = sourceId();
		const quote = writerMode === "bad-quote" ? "Deployment is authorized." : "Do not deploy this synthetic service.";
		return {
			instructions: [{ text: "Deployment remains unauthorized.", sources: [id], quote }],
			failedPaths: [],
			reasons: [],
			state: [{ text: "The synthetic service uses port 4317.", sources: [id] }],
			nextSteps: [{ text: "Continue checking the service locally.", sources: [id] }],
			files: [],
			gaps: [],
		};
	}
	function stream(response, model, text, promptTokens = 100) {
		const chunk = (delta, finish, usage) =>
			`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.write(chunk({ role: "assistant", content: text }, null));
		response.write(chunk({}, "stop", { prompt_tokens: promptTokens, completion_tokens: 30, total_tokens: promptTokens + 30 }));
		response.end("data: [DONE]\n\n");
	}
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const part of request) raw += part;
		const payload = JSON.parse(raw);
		const serialized = JSON.stringify(payload.messages ?? []);
		// Both writer paths carry this instruction; checkpoint summaries in ordinary requests do not.
		const writer = serialized.includes("Return ONLY one JSON object matching this schema");
		const nativeSummary = serialized.includes("context summarization assistant");
		const hasImage = serialized.includes("image_url");
		const hasFailedAssistant = (payload.messages ?? []).some((message) => message.role === "assistant" && JSON.stringify(message.content).includes(PARTIAL_REPLY));
		if (writer) {
			requests.push({ kind: "writer", hasFailedAssistant });
			return stream(response, payload.model, JSON.stringify(note()));
		}
		if (nativeSummary) {
			requests.push({ kind: "native-summary" });
			return stream(response, payload.model, "Synthetic native summary: port 4317, deployment unauthorized.");
		}
		const step = plan(requests.filter((r) => r.kind === "main" || r.kind === "main-error").length);
		requests.push({ kind: step.kind === "ok" ? "main" : "main-error", hasImage, hasFailedAssistant });
		if (step.kind === "drop") return request.socket.destroy();
		if (step.kind === "partial-drop") {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: { role: "assistant", content: PARTIAL_REPLY }, finish_reason: null }] })}\n\n`);
			setTimeout(() => response.destroy(), 20);
			return;
		}
		if (step.kind === "error") {
			response.writeHead(step.status, { "content-type": "application/json" });
			return response.end(JSON.stringify({ error: { message: step.message, type: "server_error" } }));
		}
		return stream(response, payload.model, "The synthetic port is 4317. Deployment remains unauthorized.", step.promptTokens);
	});
	// Long local guard work can idle a keep-alive socket; keep it open so only planned failures occur.
	server.keepAliveTimeout = 600_000;
	server.headersTimeout = 610_000;
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const model = {
		id: "synthetic-preview",
		name: "Synthetic preview",
		provider: "synthetic-preview",
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true },
	};

	// ----- session helpers -----
	const sessionsDir = join(caseDir, "sessions");
	const diagnostics = [];
	const observations = [];
	const checks = [];
	let session;
	const check = (key, description, passed, detail) => checks.push({ key, description, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
	const observe = (step, value) => observations.push({ step, ...value });
	let expectExtension = false;
	function writeSettings(extension, extra = {}) {
		expectExtension = extension;
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: extension ? [packageDir] : [], cacheWarming: "off", defaultTools: [], ...extra }),
		);
	}
	async function open(sessionManager) {
		session?.dispose();
		manager = sessionManager;
		const runtime = await stock.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
		runtime.registerProvider(model.provider, { api: model.api, apiKey: "synthetic-scenario-only", baseUrl: model.baseUrl, models: [model] });
		const settingsManager = stock.SettingsManager.create(caseDir, agentDir);
		const loader = new stock.DefaultResourceLoader({
			cwd: caseDir,
			agentDir,
			settingsManager,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "Synthetic scenario session.",
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		if (loaded.errors.length) throw new Error(`Package load errors: ${JSON.stringify(loaded.errors).slice(0, 500)}`);
		const created = await stock.createAgentSession({ cwd: caseDir, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", sessionManager, settingsManager, resourceLoader: loader, noTools: "builtin" });
		session = created.session;
		const before = notices.length;
		await session.bindExtensions({ onError: (error) => diagnostics.push(String(error?.message ?? error).slice(0, 300)) });
		const extensionLoaded = loaded.extensions.some((extension) => extension.path.startsWith(packageDir));
		if (extensionLoaded !== expectExtension) {
			throw new Error(`The preview package was ${extensionLoaded ? "loaded" : "not loaded"} although the settings ${expectExtension ? "install" : "omit"} it`);
		}
		return { extensionLoaded, notices: notices.slice(before) };
	}
	function marker() {
		if (!manager) return null;
		const path = join(agentDir, "context-memory-preview", "failures", `${createHash("sha256").update(manager.getSessionId()).digest("hex")}.json`);
		if (!existsSync(path)) return null;
		const value = JSON.parse(readFileSync(path, "utf8"));
		return { state: value.state, code: value.code };
	}
	const lastAssistant = () =>
		[...manager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant")?.message;
	const entryTypes = () => manager.getBranch().map((entry) => entry.type);
	async function prompt(text, options) {
		const before = requests.length;
		const noticesBefore = notices.length;
		let error;
		try {
			await session.prompt(text, options);
		} catch (cause) {
			error = String(cause?.message ?? cause).slice(0, 200);
		}
		const sent = requests.slice(before).map((request) => request.kind + (request.hasImage ? "+image" : ""));
		return {
			sent,
			reached: sent.some((kind) => kind.startsWith("main")),
			completed: lastAssistant()?.stopReason === "stop" && sent.at(-1)?.startsWith("main") === true && !sent.at(-1).includes("error"),
			stopReason: lastAssistant()?.stopReason,
			marker: marker(),
			notices: notices.slice(noticesBefore),
			...(error ? { error } : {}),
		};
	}
	async function compact() {
		const before = requests.length;
		const noticesBefore = notices.length;
		try {
			const result = await session.compact();
			return { ok: true, kind: result?.details?.kind ?? "native", sent: requests.slice(before).map((r) => r.kind), marker: marker(), notices: notices.slice(noticesBefore) };
		} catch (cause) {
			return { ok: false, error: String(cause?.message ?? cause).slice(0, 200), sent: requests.slice(before).map((r) => r.kind), marker: marker(), notices: notices.slice(noticesBefore) };
		}
	}
	// Runs one extension command and returns its own output; commands never reach the provider.
	async function command(text) {
		const before = requests.length;
		commandOutput = [];
		try {
			await session.prompt(text);
			return { output: commandOutput.join("\n"), sent: requests.slice(before).map((r) => r.kind), marker: marker() };
		} finally {
			commandOutput = undefined;
		}
	}
	async function seed() {
		const first = await prompt(SOURCE_TEXT);
		const second = await prompt(BIG_LOG);
		observe("seed turns 1-2", { sent: [...first.sent, ...second.sent], marker: second.marker, notices: [...first.notices, ...second.notices] });
		return first.reached && second.reached;
	}
	const newSession = () => stock.SessionManager.create(caseDir, sessionsDir);
	const nativeCheckpoint = () => manager.getBranch().some((entry) => entry.type === "compaction" && entry.details?.kind !== "pi-context-memory");
	const noCompactAdvice = (texts) => texts.length > 0 && texts.every((text) => !text.includes("/compact"));

	try {
		switch (workerCase) {
			case "documented-first-compaction": {
				// The README trial with every default: no pi-context-memory.json and default Pi settings.
				writeSettings(true);
				const opened = await open(newSession());
				observe("open fresh session", opened);
				check("ready-notice", "A fresh session shows a ready notice that is not a failure", opened.notices.some((text) => !text.includes("blocked")), opened.notices);
				check("one-open-notice", "Opening a fresh session shows a single preview notice", opened.notices.length === 1, opened.notices);
				observe("turn 1", await prompt(SOURCE_TEXT));
				const doctor = await command("/compaction-doctor");
				observe("/compaction-doctor after one turn", doctor);
				check("doctor-read-only", "The self-check calls no model and writes no failure marker", doctor.sent.length === 0 && doctor.marker === null, doctor);
				check(
					"doctor-separates-checks",
					"The self-check reports extension, host, session, writer, manual-compaction and durable-block lines",
					["extension", "host", "session", "writer", "manual /compact", "durable block"].every((label) => doctor.output.includes(label)),
					doctor.output,
				);
				check("doctor-eligibility-unknown", "The self-check does not promise /compact will run; Pi's own history gate is reported as unknown", /manual \/compact[^\n]*unknown/.test(doctor.output), doctor.output);
				// A curious user may try the recovery command on a healthy session; it must change nothing.
				const recover = await command("/compaction-recover");
				observe("/compaction-recover on a healthy session", recover);
				const afterRecover = await prompt("Continue after trying the recovery command.");
				check(
					"recover-harmless",
					"/compaction-recover on a session with nothing staged records no block, and the next prompt is sent",
					recover.sent.length === 0 && recover.marker === null && afterRecover.reached && afterRecover.marker === null,
					{ recover, afterRecover },
				);
				check("recover-not-circular", "Its refusal does not send the user back to /compaction-recover", recover.output.length > 0 && !/run \/compaction-recover/.test(recover.output), recover.output);
				const status = await command("/compaction-status");
				let parsed;
				try {
					parsed = JSON.parse(status.output);
				} catch {
					parsed = undefined;
				}
				observe("/compaction-status after one turn", { status: parsed ?? status.output });
				check(
					"status-compatible",
					"/compaction-status keeps its JSON fields and states protection and manual-compaction eligibility separately",
					parsed !== undefined &&
						["build", "enabled", "state", "writerModel", "writer", "noteBudgetMode", "manualOnly"].every((key) => key in parsed) &&
						parsed.state === "ready" &&
						parsed.protection === "eligible" &&
						parsed.manualCompaction?.pi === "unknown" &&
						status.sent.length === 0 &&
						status.marker === null,
					parsed ?? status.output,
				);
				// Pi's own 20k keep-recent gate rejects this before any extension hook.
				const short = await compact();
				observe("one-turn /compact (host gate)", short);
				check(
					"short-compact-harmless",
					"A one-turn /compact is declined by Pi itself, with no preview error notice and no failure marker",
					!short.ok && /Nothing to compact/.test(short.error) && short.marker === null && short.notices.length === 0,
					short,
				);
				observe("turn 2 (large log)", await prompt(BIG_LOG));
				const compacted = await compact();
				observe("/compact", compacted);
				check("extension-checkpoint", "With default settings and the documented history, /compact writes an extension checkpoint", compacted.ok && compacted.kind === "pi-context-memory", compacted);
				const historyTool = session.agent.state.tools.find((tool) => tool.name === "context_history");
				const history = await historyTool?.execute("synthetic-history-check", { operation: "read", entryId: sourceId() });
				check("history-readable", "After the first checkpoint, the original user entry is readable from the same branch", JSON.stringify(history)?.includes("Do not deploy this synthetic service.") === true);
				const next = await prompt("Which port did I approve?");
				observe("turn 3", next);
				check("next-prompt-sent", "The next prompt reaches the provider", next.reached, next);
				await open(stock.SessionManager.open(manager.getSessionFile()));
				const reopened = await prompt("Continue after reopening.");
				check("reopen-usable", "The compacted session continues after reopening", reopened.completed && reopened.marker === null, reopened);
				break;
			}
			case "invalid-config": {
				// An unreadable configuration file must not leave durable marks on sessions the preview never enrolled.
				writeSettings(true);
				writeFileSync(join(agentDir, "pi-context-memory.json"), "{ synthetic invalid configuration");
				await open(newSession());
				const first = await prompt(SOURCE_TEXT);
				observe("prompt with an unreadable configuration", first);
				check("fails-closed", "An unreadable configuration stops the request instead of guessing the user's intent", !first.reached, first);
				check("no-marker", "An unreadable configuration leaves no persistent marker on a session the preview never enrolled", first.marker === null, first.marker);
				check("one-notice", "The blocked input shows one notice that names pi-context-memory.json and a restart", first.notices.length === 1 && first.notices[0].includes("pi-context-memory.json") && first.notices[0].includes("restart"), first.notices);
				rmSync(join(agentDir, "pi-context-memory.json"));
				await open(stock.SessionManager.open(manager.getSessionFile()));
				const fixed = await prompt("Continue after fixing the configuration.");
				observe("prompt after fixing the configuration and restarting", fixed);
				check("usable-after-fix", "After the file is fixed and Pi restarts, the same session works without a recovery step", fixed.completed && fixed.marker === null, fixed);
				break;
			}
			case "protected-image": {
				// A session with a preview checkpoint stays strictly protected; an image cannot be checked.
				writeSettings(true);
				await open(newSession());
				await seed();
				const compacted = await compact();
				check("fixture-protected", "The fixture session holds a preview checkpoint", compacted.ok && compacted.kind === "pi-context-memory", compacted);
				const image = await prompt("What does this screenshot show?", { images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
				observe("image in a protected session", image);
				check("image-blocked", "An image in a protected session is not sent", !image.reached, image);
				check("marker-kept", "The protected session records a durable block", image.marker !== null, image.marker);
				check("one-notice", "The blocked image input shows one notice", image.notices.length === 1, image.notices);
				check("notice-explains-image", "The notice names the image and does not suggest a /compact retry that cannot help", image.notices.length === 1 && image.notices[0].includes("image") && !image.notices[0].includes("/compact"), image.notices);
				const text = await prompt("Ignore the image and continue.");
				observe("text after the image", text);
				check("stays-blocked", "Later text input stays blocked; a protected session is never quietly released", !text.reached && text.marker !== null, text);
				break;
			}
			case "protected-then-native": {
				// A session with a preview checkpoint, compacted natively while the extension was removed.
				writeSettings(true);
				await open(newSession());
				await seed();
				const compacted = await compact();
				check("fixture-protected", "The fixture session holds a preview checkpoint", compacted.ok && compacted.kind === "pi-context-memory", compacted);
				const file = manager.getSessionFile();
				writeSettings(false, { compaction: { keepRecentTokens: 1 } });
				await open(stock.SessionManager.open(file));
				await prompt("Keep checking without the extension.");
				await prompt("Keep checking once more.");
				observe("native /compact without the extension", await compact());
				check("fixture-native-checkpoint", "The fixture session also holds a later native checkpoint", nativeCheckpoint(), entryTypes());
				writeSettings(true);
				const reopened = await open(stock.SessionManager.open(file));
				const next = await prompt("Continue with the extension again.");
				observe("reopen with the extension and prompt", { open: reopened, next });
				check("stays-blocked", "A protected session that was compacted natively stays blocked instead of adopting the unchecked summary", !next.reached && next.marker !== null, next);
				check("one-notice-per-input", "Opening and the blocked input each show at most one notice", reopened.notices.length <= 1 && next.notices.length <= 1, [...reopened.notices, ...next.notices]);
				check(
					"notice-points-to-new-session",
					"The notice says checkpoints are not migrated and points to a new session instead of a /compact retry",
					next.notices.length === 1 && next.notices[0].includes("new session") && !next.notices[0].includes("/compact"),
					next.notices,
				);
				break;
			}
			case "provider-retry":
			case "provider-connection-drop":
			case "provider-partial-drop":
			case "provider-repeated-retry":
			case "provider-first-turn-retry":
			case "provider-retry-exhausted": {
				// Pi's default retry policy; SDK-level retries off so Pi's own retry runs, with a short backoff.
				writeSettings(withExtension, { retry: { baseDelayMs: 20, provider: { maxRetries: 0 } } });
				const failure = workerCase === "provider-connection-drop" ? { kind: "drop" } : workerCase === "provider-partial-drop" ? { kind: "partial-drop" } : { kind: "error", status: 503, message: "Service temporarily overloaded" };
				const firstTurn = workerCase === "provider-first-turn-retry";
				const exhausted = workerCase === "provider-retry-exhausted";
				const failures = workerCase === "provider-repeated-retry" ? 3 : 1;
				const firstFailure = firstTurn ? 0 : 2;
				plan = (n) => (n >= firstFailure && (exhausted || n < firstFailure + failures) ? failure : { kind: "ok" });
				if (workerCase === "provider-partial-drop" && withExtension) {
					writeFileSync(join(agentDir, "pi-context-memory.json"), JSON.stringify({ keepRecentTokens: 64 }));
				}
				await open(newSession());
				const seeded = firstTurn || await seed();
				const turn = await prompt(firstTurn ? SOURCE_TEXT : "Check the service again.");
				observe("provider failure and Pi retry", { ...turn, entries: entryTypes() });
				if (exhausted) {
					check("retries-exhausted", "Pi reaches its retry limit without completing the failed turn", !turn.completed && turn.sent.length === 4, turn);
					check("no-marker", "Exhausting provider retries does not become a compaction failure", turn.marker === null, turn.marker);
					plan = () => ({ kind: "ok" });
					const next = await prompt("Continue when the provider is healthy.");
					check("next-prompt-sent", "The next prompt completes after the provider recovers", next.completed && next.marker === null, next);
					break;
				}
				if (withExtension) {
					if (!firstTurn) check("seeded", "The first two turns reach the provider", seeded);
					check("retry-completes", "Pi's automatic retry reaches the provider and completes the turn", turn.completed && turn.sent.length === failures + 1, turn);
					check("no-marker", "A transient provider failure leaves no persistent failure marker", turn.marker === null, turn.marker);
					if (workerCase === "provider-partial-drop") {
						check("partial-reply-recorded", "The dropped stream leaves its partial reply in original history", manager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error" && JSON.stringify(entry.message.content).includes(PARTIAL_REPLY)));
					}
					if (!firstTurn) {
						const compacted = await compact();
						observe("/compact", compacted);
						check("manual-compact-succeeds", "Manual compaction after retry confirms an extension checkpoint", compacted.ok && compacted.kind === "pi-context-memory" && compacted.marker === null, compacted);
						const historyTool = session.agent.state.tools.find((tool) => tool.name === "context_history");
						const history = await historyTool?.execute("synthetic-history-check", { operation: "read", entryId: sourceId() });
						check("history-readable", "Original user evidence remains retrievable after retry and compaction", JSON.stringify(history)?.includes("Do not deploy this synthetic service.") === true);
					}
					const next = await prompt("Continue.");
					check("next-prompt-sent", "The next prompt completes after retry and compaction", next.completed && next.marker === null, next);
					await session.reload();
					const reloaded = await prompt("Continue after reload.");
					check("reload-usable", "Reload preserves a usable retry session", reloaded.completed && reloaded.marker === null, reloaded);
					await open(stock.SessionManager.open(manager.getSessionFile()));
					const reopened = await prompt("Continue after reopening.");
					check("reopen-usable", "Reopening preserves a usable retry session", reopened.completed && reopened.marker === null, reopened);
					check("no-omitted-assistant", "Retry and compaction never reintroduce the omitted partial assistant response", requests.every((request) => !request.hasFailedAssistant));
				} else {
					check("retry-completes", "Without the preview, Pi retries and completes the turn", turn.completed && turn.sent.length === failures + 1, turn);
					check("context-edit-written", "Pi records the failed attempt as a context_edit before retrying", entryTypes().includes("context_edit"), entryTypes());
				}
				break;
			}
			case "legacy-retry-marker": {
				writeSettings(true);
				await open(newSession());
				await seed();
				manager.appendMessage({ role: "user", content: "Keep checking the unfinished local request.", timestamp: Date.now() });
				const failedId = manager.appendMessage({ ...lastAssistant(), stopReason: "error", content: [], errorMessage: "Synthetic transient failure", timestamp: Date.now() });
				manager.appendContextEdit(failedId, null);
				const directory = join(agentDir, "context-memory-preview", "failures");
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				const markerPath = join(directory, `${createHash("sha256").update(manager.getSessionId()).digest("hex")}.json`);
				writeFileSync(markerPath, JSON.stringify({ version: 1, state: "blocked", code: "CONTEXT_PREVIEW_UNSUPPORTED", sessionId: manager.getSessionId(), sessionPathHash: createHash("sha256").update(realpathSync(manager.getSessionFile())).digest("hex") }), { mode: 0o600 });
				await open(stock.SessionManager.open(manager.getSessionFile()));
				const blocked = await prompt("Continue without compaction.");
				check("blocked-before-retry", "An old marker remains blocking until explicit recovery", !blocked.reached && blocked.marker !== null, blocked);
				await session.prompt("/compaction-recover");
				check("unstaged-not-recovered", "Recover cannot clear an old marker without a staged checkpoint", marker() !== null, marker());
				const compacted = await compact();
				check("explicit-retry-recovers", "Explicit compaction validates the old recovery edit and confirms a new checkpoint", compacted.ok && compacted.kind === "pi-context-memory" && compacted.marker === null, compacted);
				check("unfinished-request-kept", "Recovery retains the whole unfinished original user request", manager.buildSessionProjection().messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Keep checking the unfinished local request.")));
				const next = await prompt("Continue after confirmed recovery.");
				check("next-prompt-sent", "The recovered legacy session completes its next prompt", next.completed && next.marker === null, next);
				break;
			}
			case "context-overflow": {
				writeSettings(withExtension, { retry: { baseDelayMs: 20, provider: { maxRetries: 0 } } });
				plan = (n) => (n === 2 ? { kind: "error", status: 400, message: "This request exceeds the context window of this model." } : { kind: "ok" });
				await open(newSession());
				await seed();
				const turn = await prompt("Read the large log.");
				observe("turn 3 (provider reports context overflow)", { ...turn, entries: entryTypes() });
				if (withExtension) {
					check("no-native-summary", "The preview never falls back to a native summary", !requests.some((r) => r.kind === "native-summary") && !nativeCheckpoint(), turn.sent);
					const compacted = await compact();
					observe("/compact", compacted);
					check("manual-compact-recovers", "Manual /compact recovers the session after an overflow", compacted.ok && compacted.kind === "pi-context-memory", compacted);
					check("unfinished-request-kept", "Overflow recovery retains the original unfinished request", manager.buildSessionProjection().messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Read the large log.")));
					const next = await prompt("Continue.");
					observe("turn 4", next);
					check("next-prompt-sent", "The next prompt reaches the provider", next.reached, next);
				} else {
					check("native-recovers", "Without the preview, native compaction recovers and the turn completes", turn.completed && nativeCheckpoint(), turn);
				}
				break;
			}
			case "threshold": {
				// 115k reported input tokens cross Pi's default threshold (window - 16,384 reserve) without overflowing.
				writeSettings(withExtension);
				plan = (n) => (n === 1 ? { kind: "ok", promptTokens: 115_000 } : { kind: "ok" });
				await open(newSession());
				await seed();
				if (withExtension) {
					check("no-native-summary", "Crossing the threshold does not run native compaction", !requests.some((r) => r.kind === "native-summary") && !nativeCheckpoint(), requests);
					const checkpoint = manager.getBranch().find((entry) => entry.type === "compaction" && entry.details?.kind === "pi-context-memory");
					check("threshold-checkpoint", "Crossing the threshold after a completed turn writes a checked checkpoint with the writer", checkpoint !== undefined && requests.some((r) => r.kind === "writer"), { requests, entries: entryTypes() });
					check("no-marker", "Threshold compaction leaves no failure marker", marker() === null, marker());
					const next = await prompt("Continue.");
					observe("turn 3", next);
					check("next-prompt-sent", "The next prompt reaches the provider after the checkpoint", next.reached, next);
				} else {
					check("native-compacts", "Without the preview, Pi compacts natively at the threshold", requests.some((r) => r.kind === "native-summary") && nativeCheckpoint(), requests);
				}
				break;
			}
			case "image-input": {
				writeSettings(withExtension);
				await open(newSession());
				await seed();
				const image = await prompt("What does this screenshot show?", { images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
				observe("turn 3 (one image)", image);
				const text = await prompt("Ignore the image and continue.");
				observe("turn 4 (text)", text);
				if (withExtension) {
					check("text-after-image-sent", "Text input after an image attempt reaches the provider", text.reached, text);
					check("no-marker", "An image attempt leaves no persistent failure marker", text.marker === null, text.marker);
					check("notice-explains-image", "The image notice explains the limit instead of advising a /compact retry", noCompactAdvice(image.notices), image.notices);
				} else {
					check("image-sent", "Without the preview, the image prompt reaches the provider", image.sent.includes("main+image"), image.sent);
				}
				break;
			}
			case "native-checkpoint-session": {
				// An ordinary session with a native Pi checkpoint, opened after the extension is installed.
				writeSettings(false, { compaction: { keepRecentTokens: 1 } });
				await open(newSession());
				await prompt(SOURCE_TEXT);
				await prompt("Keep checking.");
				observe("native /compact without the extension", await compact());
				check("fixture-native-checkpoint", "The fixture session holds a native checkpoint", nativeCheckpoint(), entryTypes());
				const file = manager.getSessionFile();
				// The user's own Pi compaction settings stay as they were.
				writeSettings(true, { compaction: { keepRecentTokens: 1 } });
				const reopened = await open(stock.SessionManager.open(file));
				observe("reopen with the extension", { ...reopened, marker: marker() });
				check("no-marker-on-open", "Opening a session the extension never enrolled writes no failure marker", marker() === null, marker());
				check("one-notice-on-open", "Opening it says once that the preview is not active in this session", reopened.notices.length === 1 && !reopened.notices[0].includes("/compact"), reopened.notices);
				const next = await prompt("Continue the old task.");
				observe("turn 3", next);
				check("prompt-sent", "The old session stays usable", next.reached, next);
				const compacted = await compact();
				observe("/compact in a session the preview does not protect", compacted);
				check("compact-left-to-pi", "/compact in a session the preview does not protect is left to Pi and writes no marker", compacted.ok && compacted.kind === "native" && compacted.marker === null, compacted);
				break;
			}
			case "enrolled-then-native": {
				// Created with the extension, compacted natively by Pi without it, then reopened with it again.
				writeSettings(true);
				await open(newSession());
				await seed();
				const file = manager.getSessionFile();
				writeSettings(false, { compaction: { keepRecentTokens: 1 } });
				await open(stock.SessionManager.open(file));
				await prompt("Keep checking without the extension.");
				observe("native /compact without the extension", await compact());
				check("fixture-native-checkpoint", "The fixture session holds a native checkpoint", nativeCheckpoint(), entryTypes());
				writeSettings(true);
				const reopened = await open(stock.SessionManager.open(file));
				const next = await prompt("Continue with the extension again.");
				observe("reopen with the extension and prompt", { open: reopened, next });
				check("prompt-sent", "A session that left protection through native compaction stays usable", next.reached, next);
				check("one-notice", "The user is told once that the session is no longer protected", reopened.notices.length + next.notices.length === 1, [...reopened.notices, ...next.notices]);
				break;
			}
			case "in-memory-session": {
				writeSettings(withExtension);
				await open(stock.SessionManager.inMemory(caseDir));
				const first = await prompt(SOURCE_TEXT);
				observe("turn 1", first);
				check("prompt-sent", withExtension ? "An in-memory session (pi --no-session) stays usable" : "Without the preview, an in-memory session works", first.reached, first);
				break;
			}
			case "other-pi-version": {
				writeSettings(withExtension);
				await open(newSession());
				const first = await prompt(SOURCE_TEXT);
				observe("turn 1", first);
				if (withExtension) {
					check("fresh-session-usable", `A fresh session stays usable on Pi ${piVersion}`, first.reached, first);
					check("no-marker", `A fresh session on Pi ${piVersion} gets no failure marker`, first.marker === null, first.marker);
				} else {
					check("prompt-sent", `Without the preview, Pi ${piVersion} works`, first.reached, first);
				}
				break;
			}
			case "failed-compaction-notices": {
				writeSettings(true);
				writerMode = "bad-quote";
				await open(newSession());
				await seed();
				const failed = await compact();
				observe("/compact with a misquoting writer", failed);
				const blocked = await prompt("Continue.");
				observe("turn 3", blocked);
				check("rejected-and-blocked", "A misquoting writer is rejected and later requests are blocked", !failed.ok && failed.marker !== null && !blocked.reached, { failed, blocked });
				check("one-notice-for-failure", "A failed compaction shows one notice", failed.notices.length === 1, failed.notices.length);
				check("one-notice-per-blocked-input", "A blocked input shows at most one notice", blocked.notices.length <= 1, blocked.notices.length);
				writerMode = "good";
				const retried = await compact();
				const next = await prompt("Continue after retry.");
				observe("/compact retry and turn 4", { retried, next });
				check("explicit-retry-recovers", "An explicit /compact retry clears the block", retried.ok && retried.marker === null && next.reached, { retried, next });
				break;
			}
			case "long-session-overhead": {
				// Overhead per model request: each probe is a short prompt that makes exactly one provider request.
				const target = Number(argument("--perf-checkpoints", "20"));
				const milestones = [...new Set([Math.min(10, target), target])];
				const chunk = Array.from({ length: 6000 }, (_, i) => `trace ${String(i).padStart(5, "0")}: local check ok, port 4317 healthy`).join("\n");
				async function probe(milestone) {
					const times = [];
					const intervals = [];
					for (let i = 0; i < 3; i++) {
						const beginUs = Number(process.hrtime.bigint() / 1000n);
						const started = performance.now();
						const result = await prompt("Small follow-up question.");
						times.push(performance.now() - started);
						intervals.push({ beginUs, endUs: Number(process.hrtime.bigint() / 1000n) });
						if (result.sent.length !== 1 || !result.reached) throw new Error(`Probe did not make exactly one request: ${JSON.stringify(result)}`);
					}
					observe("raw request timing samples", { milestone, samplesMs: times, monotonicIntervalsUs: intervals });
					return median(times);
				}
				writeSettings(true);
				await open(newSession());
				await prompt(SOURCE_TEXT);
				const measured = [];
				let completed = 0;
				for (let cycle = 1; cycle <= target; cycle++) {
					await prompt(`Cycle ${cycle}: keep checking.`);
					await prompt(`Trace batch ${cycle}:\n${chunk}`);
					const result = await compact();
					if (!result.ok) {
						observe(`compaction failed at checkpoint ${cycle}`, result);
						break;
					}
					completed = cycle;
					if (milestones.includes(cycle)) {
						measured.push({ checkpoints: cycle, sessionMB: Number((statSync(manager.getSessionFile()).size / 1e6).toFixed(1)), extensionMs: Math.round(await probe(cycle)) });
					}
				}
				check("compactions-succeed", `All ${target} manual compactions succeed`, completed === target, completed);
				const file = manager.getSessionFile();
				writeSettings(false);
				await open(stock.SessionManager.open(file));
				const baselineMs = Math.round(await probe("disabled-control"));
				const rows = measured.map((row) => ({ ...row, baselineMs, overheadMs: Math.max(0, row.extensionMs - baselineMs) }));
				observe("overhead per model request", { rows });
				const first = rows.at(0);
				const last = rows.at(-1);
				check("per-request-budget", `Extension overhead per model request stays within 50 ms at ${target} checkpoints`, last !== undefined && last.overheadMs <= 50, last);
				// The full target is 10 -> 60 checkpoints at most doubling; CI applies the same bound to 10 -> N.
				// A 5 ms floor keeps timer noise on a fast path from reading as growth.
				check("bounded-growth", `Overhead at most doubles from ${first?.checkpoints} to ${target} checkpoints`, first !== undefined && last !== undefined && last.overheadMs <= 2 * Math.max(first.overheadMs, 5), rows);
				break;
			}
			default:
				throw new Error(`Unknown scenario ${workerCase}`);
		}
	} catch (error) {
		check("harness", "The scenario ran to completion", false, String(error?.stack ?? error).slice(0, 800));
	} finally {
		session?.dispose();
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
	}
	const result = { case: workerCase, variant, pi: piVersion, providerRequests: requests.length, diagnostics, checks, observations };
	writeFileSync(join(caseDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------
// Parent: run every case in isolated processes, then grade the checks against KNOWN_GAPS.
// ---------------------------------------------------------------------------------------------------------

// The package's host imports must reach the Pi under test. From inside this repository, once
// `npm run build:offline` has run, they resolve to the workspace build instead, so a copy outside it is loaded.
function assertNoShadowingHost(directory) {
	for (let current = directory; ; current = dirname(current)) {
		for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]) {
			if (existsSync(join(current, "node_modules", name))) {
				throw new Error(`${join(current, "node_modules", name)} would shadow the host under test; point TMPDIR outside any Node project`);
			}
		}
		if (dirname(current) === current) return;
	}
}

async function runWorker(name, variant, root, timeoutMs, candidate) {
	const caseDir = join(outputDir, "cases", `${name}--${variant}`);
	rmSync(caseDir, { recursive: true, force: true });
	mkdirSync(caseDir, { recursive: true });
	const agentDir = join(caseDir, "agent");
	const parameters = [script, "--package-dir", candidate, "--stock-root", root, "--output-dir", outputDir, "--worker", name, "--variant", variant, "--perf-checkpoints", argument("--perf-checkpoints", "20")];
	const child = spawn(process.execPath, parameters, { cwd: outputDir, env: environment(agentDir), stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stdout.on("data", () => {});
	child.stderr.on("data", (data) => {
		stderr = (stderr + data).slice(-4000);
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	const [code] = await once(child, "exit");
	clearTimeout(timer);
	const resultPath = join(caseDir, "result.json");
	const result = existsSync(resultPath)
		? JSON.parse(readFileSync(resultPath, "utf8"))
		: { case: name, variant, checks: [{ key: "harness", description: "The scenario ran to completion", passed: false, detail: `exit ${code}: ${stderr}` }], observations: [] };
	// Keep compact evidence only; synthetic sessions, settings and markers are removed.
	for (const entry of readdirSync(caseDir)) if (entry !== "result.json") rmSync(join(caseDir, entry), { recursive: true, force: true });
	return result;
}

async function parent() {
	mkdirSync(outputDir, { recursive: true });
	const otherStockRoot = argument("--other-stock-root", "");
	const only = argument("--only", "");
	const profile = argument("--acceptance-profile", "strict");
	const packageManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const packageBuild = JSON.parse(readFileSync(join(packageDir, "preview-build.json"), "utf8"));
	assertProfileVersion(profile, packageManifest.version);
	if (packageBuild.version !== packageManifest.version) throw new Error("Candidate version identity mismatch");
	const fileHash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
	const hostVersion = (root) => JSON.parse(readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
	const manifest = { spec: "0.4-preview-latency.1", suite: "S1/default-settings", providers: "loopback synthetic only",
		runnerSha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
		package: packageBuild,
		host: inspectOfficialPi(stockRoot, hostVersion(stockRoot)),
		...(otherStockRoot ? { otherHost: inspectOfficialPi(otherStockRoot, hostVersion(otherStockRoot)) } : {}),
		checkpointTarget: Number(argument("--perf-checkpoints", "20")), only: only || null };
	writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	const report = { host: "official npm Pi", providers: "loopback HTTP synthetic only", packageCopy: "temporary directory outside the repository", knownGaps: [...KNOWN_GAPS],
		candidate: { version: packageManifest.version, sourceCommit: packageBuild.sourceCommit, build: packageBuild.build, sourceHash: packageBuild.sourceHash,
			manifestHash: fileHash(join(packageDir, "package.json")), entryHash: fileHash(join(packageDir, packageManifest.pi.extensions[0])), buildMetadataHash: fileHash(join(packageDir, "preview-build.json")) },
		scope: { only: only || null, checkpointTarget: manifest.checkpointTarget, otherHostVersion: manifest.otherHost?.version ?? null }, cases: [], checks: [] };
	const counts = { pass: 0, gap: 0, fail: 0, nowPasses: 0, skipped: 0 };
	const isolatedRoot = mkdtempSync(join(tmpdir(), "pi-preview-scenarios-"));
	const candidate = join(isolatedRoot, "package");
	cpSync(packageDir, candidate, { recursive: true });
	try {
		assertNoShadowingHost(candidate);
		await runCases(report, counts, otherStockRoot, only, candidate);
	} finally {
		rmSync(isolatedRoot, { recursive: true, force: true });
	}
	report.summary = counts;
	report.passed = counts.fail === 0 && counts.nowPasses === 0;
	// Raw checks, calculations and the original gate remain intact. Acceptance is a separate version-bound decision.
	report.acceptance = gradeScenarioAcceptance(report, profile);
	writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(
		`\n${counts.pass} passed, ${counts.gap} known gaps, ${counts.fail} failed, ${counts.nowPasses} now passing and still listed, ${counts.skipped} skipped\n`,
	);
	process.stdout.write(`Acceptance profile ${report.acceptance.profile}: ${report.acceptance.accepted ? "accepted" : "rejected"}; raw gate ${report.passed ? "passed" : "failed"}; ${report.acceptance.exceptions.length} declared performance exceptions\n`);
	if (!report.acceptance.accepted) process.exitCode = 1;
}

async function runCases(report, counts, otherStockRoot, only, candidate) {
	for (const entry of CASES) {
		if (only && entry.name !== only) continue;
		if (entry.otherHost && !otherStockRoot) {
			counts.skipped++;
			report.cases.push({ case: entry.name, skipped: "no --other-stock-root" });
			process.stdout.write(`SKIP ${entry.name}: pass --other-stock-root to test another Pi version\n`);
			continue;
		}
		for (const variant of entry.variants) {
			const root = entry.otherHost ? resolve(otherStockRoot) : stockRoot;
			const result = await runWorker(entry.name, variant, root, entry.timeoutMs ?? 180_000, candidate);
			report.cases.push(result);
			for (const item of result.checks) {
				const id = variant === "control" ? `${entry.name}:control/${item.key}` : `${entry.name}/${item.key}`;
				const gap = KNOWN_GAPS.has(id);
				const status = item.passed ? (gap ? "now-passes" : "pass") : gap ? "known-gap" : "fail";
				report.checks.push({ id, description: item.description, status, pi: result.pi });
				if (status === "pass") counts.pass++;
				else if (status === "known-gap") counts.gap++;
				else if (status === "now-passes") counts.nowPasses++;
				else counts.fail++;
				const label = { pass: "PASS", "known-gap": "KNOWN GAP", "now-passes": "NOW PASSES", fail: "FAIL" }[status];
				const hint = status === "now-passes" ? " (remove it from KNOWN_GAPS so it becomes a required regression)" : "";
				const detail = status === "fail" && item.detail !== undefined ? `: ${JSON.stringify(item.detail).slice(0, 600)}` : "";
				process.stdout.write(`${label} ${id} - ${item.description}${hint}${detail}\n`);
			}
		}
	}
}

if (workerCase) await worker();
else await parent();
