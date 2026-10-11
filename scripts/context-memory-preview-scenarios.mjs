import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Default-settings scenarios for the stock-Pi preview, each beside a control run without the extension.
// Uses only an official npm Pi installation and a loopback mock provider. Never contacts a model service.
//
// Every check states the intended behavior. Checks listed in KNOWN_GAPS are not provided by the current
// preview: they are reported and do not fail the run. A listed check that starts passing fails the run
// until it is removed from KNOWN_GAPS, so a fix cannot land without becoming a required regression.
const KNOWN_GAPS = new Set([
	"documented-first-compaction/ready-notice",
	"provider-retry/retry-completes",
	"provider-retry/no-marker",
	"provider-connection-drop/retry-completes",
	"provider-connection-drop/no-marker",
	"context-overflow/manual-compact-recovers",
	"context-overflow/next-prompt-sent",
	"threshold/notice-asks-for-compact",
	"threshold/one-notice-per-input",
	"image-input/text-after-image-sent",
	"image-input/no-marker",
	"image-input/notice-explains-image",
	"native-checkpoint-session/no-marker-on-open",
	"native-checkpoint-session/prompt-sent",
	"enrolled-then-native/prompt-sent",
	"enrolled-then-native/one-notice",
	"in-memory-session/prompt-sent",
	"other-pi-version/fresh-session-usable",
	"other-pi-version/no-marker",
	"failed-compaction-notices/one-notice-for-failure",
	"failed-compaction-notices/one-notice-per-blocked-input",
	"long-session-overhead/per-request-budget",
	"long-session-overhead/bounded-growth",
]);

const CASES = [
	{ name: "documented-first-compaction", variants: ["extension"] },
	{ name: "provider-retry", variants: ["extension", "control"] },
	{ name: "provider-connection-drop", variants: ["extension", "control"] },
	{ name: "context-overflow", variants: ["extension", "control"] },
	{ name: "threshold", variants: ["extension", "control"] },
	{ name: "image-input", variants: ["extension", "control"] },
	{ name: "native-checkpoint-session", variants: ["extension"] },
	{ name: "enrolled-then-native", variants: ["extension"] },
	{ name: "in-memory-session", variants: ["extension", "control"] },
	{ name: "other-pi-version", variants: ["extension", "control"], otherHost: true },
	{ name: "failed-compaction-notices", variants: ["extension"] },
	{ name: "long-session-overhead", variants: ["extension"], timeoutMs: 1_200_000 },
];

const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
function argument(name, fallback) {
	const index = args.indexOf(name);
	if (index >= 0 && args[index + 1]) return args[index + 1];
	if (fallback !== undefined) return fallback;
	throw new Error(
		`Missing ${name}. Usage: node ${script} --package-dir <candidate> --stock-root <official npm installation> --output-dir <evidence> [--other-stock-root <another Pi version>] [--perf-checkpoints 20] [--only <case>]`,
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
	for (const level of ["log", "warn", "error"]) {
		const original = console[level].bind(console);
		console[level] = (...parts) => {
			const text = parts.map(String).join(" ");
			if (text.includes("context-memory preview")) notices.push(text);
			else original(...parts);
		};
	}

	const stockPackage = join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent");
	const stock = await import(pathToFileURL(join(stockPackage, "dist", "index.js")).href);
	const piVersion = JSON.parse(readFileSync(join(stockPackage, "package.json"), "utf8")).version;

	const SOURCE_TEXT = "Use port 4317. Do not deploy this synthetic service. Continue checking it locally.";
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
		if (writer) {
			requests.push({ kind: "writer" });
			return stream(response, payload.model, JSON.stringify(note()));
		}
		if (nativeSummary) {
			requests.push({ kind: "native-summary" });
			return stream(response, payload.model, "Synthetic native summary: port 4317, deployment unauthorized.");
		}
		const step = plan(requests.filter((r) => r.kind === "main" || r.kind === "main-error").length);
		requests.push({ kind: step.kind === "ok" ? "main" : "main-error", hasImage });
		if (step.kind === "drop") return request.socket.destroy();
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
	function writeSettings(extension, extra = {}) {
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
		return { extensionLoaded: loaded.extensions.some((extension) => extension.path.startsWith(packageDir)), notices: notices.slice(before) };
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
				observe("turn 1", await prompt(SOURCE_TEXT));
				// Pi's own 20k keep-recent gate rejects this before any extension hook; recorded, not asserted.
				observe("one-turn /compact (host gate)", await compact());
				observe("turn 2 (large log)", await prompt(BIG_LOG));
				const compacted = await compact();
				observe("/compact", compacted);
				check("extension-checkpoint", "With default settings and the documented history, /compact writes an extension checkpoint", compacted.ok && compacted.kind === "pi-context-memory", compacted);
				const next = await prompt("Which port did I approve?");
				observe("turn 3", next);
				check("next-prompt-sent", "The next prompt reaches the provider", next.reached, next);
				break;
			}
			case "provider-retry":
			case "provider-connection-drop": {
				// Pi's default retry policy; SDK-level retries off so Pi's own retry runs, with a short backoff.
				writeSettings(withExtension, { retry: { baseDelayMs: 20, provider: { maxRetries: 0 } } });
				const failure = workerCase === "provider-retry" ? { kind: "error", status: 503, message: "Service temporarily overloaded" } : { kind: "drop" };
				plan = (n) => (n === 2 ? failure : { kind: "ok" });
				await open(newSession());
				const seeded = await seed();
				const turn = await prompt("Check the service again.");
				observe("turn 3 (one transient provider failure)", { ...turn, entries: entryTypes() });
				if (withExtension) {
					check("seeded", "The first two turns reach the provider", seeded);
					check("retry-completes", "Pi's automatic retry reaches the provider and completes the turn", turn.completed && turn.sent.length >= 2, turn);
					check("no-marker", "A transient provider failure leaves no persistent failure marker", turn.marker === null, turn.marker);
					observe("/compact", await compact());
					observe("turn 4", await prompt("Continue."));
				} else {
					check("retry-completes", "Without the preview, Pi retries and completes the turn", turn.completed && turn.sent.length >= 2, turn);
					check("context-edit-written", "Pi records the failed attempt as a context_edit before retrying", entryTypes().includes("context_edit"), entryTypes());
				}
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
					const blocked = await prompt("Continue.");
					observe("turn 3", blocked);
					check("blocked-until-compact", "Requests stay blocked until a manual /compact", !blocked.reached, blocked);
					check("notice-asks-for-compact", "The notice asks for /compact and does not call the session unsupported", blocked.notices.length > 0 && blocked.notices.every((text) => text.includes("/compact") && !text.includes("UNSUPPORTED")), blocked.notices);
					check("one-notice-per-input", "A blocked input shows at most one notice", blocked.notices.length <= 1, blocked.notices.length);
					const compacted = await compact();
					observe("/compact", compacted);
					const next = await prompt("Continue after compaction.");
					observe("turn 4", next);
					check("manual-compact-recovers", "Manual /compact recovers and the next prompt reaches the provider", compacted.ok && next.reached, { compacted, next });
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
				writeSettings(true);
				const reopened = await open(stock.SessionManager.open(file));
				observe("reopen with the extension", { ...reopened, marker: marker() });
				check("no-marker-on-open", "Opening a session the extension never enrolled writes no failure marker", marker() === null, marker());
				const next = await prompt("Continue the old task.");
				observe("turn 3", next);
				check("prompt-sent", "The old session stays usable", next.reached, next);
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
				async function probe() {
					const times = [];
					for (let i = 0; i < 3; i++) {
						const started = performance.now();
						const result = await prompt("Small follow-up question.");
						times.push(performance.now() - started);
						if (result.sent.length !== 1 || !result.reached) throw new Error(`Probe did not make exactly one request: ${JSON.stringify(result)}`);
					}
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
						measured.push({ checkpoints: cycle, sessionMB: Number((statSync(manager.getSessionFile()).size / 1e6).toFixed(1)), extensionMs: Math.round(await probe()) });
					}
				}
				check("compactions-succeed", `All ${target} manual compactions succeed`, completed === target, completed);
				const file = manager.getSessionFile();
				writeSettings(false);
				await open(stock.SessionManager.open(file));
				const baselineMs = Math.round(await probe());
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

async function runWorker(name, variant, root, timeoutMs) {
	const caseDir = join(outputDir, "cases", `${name}--${variant}`);
	rmSync(caseDir, { recursive: true, force: true });
	mkdirSync(caseDir, { recursive: true });
	const agentDir = join(caseDir, "agent");
	const parameters = [script, "--package-dir", packageDir, "--stock-root", root, "--output-dir", outputDir, "--worker", name, "--variant", variant, "--perf-checkpoints", argument("--perf-checkpoints", "20")];
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
	const report = { host: "official npm Pi", providers: "loopback HTTP synthetic only", knownGaps: [...KNOWN_GAPS], cases: [], checks: [] };
	const counts = { pass: 0, gap: 0, fail: 0, nowPasses: 0, skipped: 0 };
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
			const result = await runWorker(entry.name, variant, root, entry.timeoutMs ?? 180_000);
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
	report.summary = counts;
	report.passed = counts.fail === 0 && counts.nowPasses === 0;
	writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(
		`\n${counts.pass} passed, ${counts.gap} known gaps, ${counts.fail} failed, ${counts.nowPasses} now passing and still listed, ${counts.skipped} skipped\n`,
	);
	if (!report.passed) process.exitCode = 1;
}

if (workerCase) await worker();
else await parent();
