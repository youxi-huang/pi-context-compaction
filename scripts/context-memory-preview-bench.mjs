import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The 0.5.0 writer bench and recovery probes for the independent preview on official Pi.
//
// Sessions come from eval/preview: invented, generated JSONL, cut at fixed checkpoints. No model drives the task;
// only writer calls and probe answers reach a provider. Two modes:
//
//   writer  For each checkpoint cut, earlier cuts are compacted by a deterministic loopback writer that builds
//           faithful notes from the gold files; the measured writer then compacts the cut on fresh copies,
//           --attempts times. Reports refusals by error code and quotation class, repairs and their cost, and
//           for each committed note its size against the bytes it condenses and the gold answers it still cites.
//   probes  The measured writer compacts every cut in order, retrying a refused /compact up to --chain-attempts
//           times in all, so that recall is measured on committed notes; writer mode measures refusals.
//           Each probe then runs on its own copy of the chain at its checkpoint, once with only context_history
//           active and once with no tools. Reports typed-answer scores, retrieval calls and missed-entry probes.
//   repair  For each quotation-repair case of eval/preview/repair.ts, the writer's first call is answered with the
//           case's planted candidate and only the repair reaches the measured model. Reports scores by template
//           and, for the repair calls, stop reasons, the reasoning settings sent, tokens and time.
//
// --provider loopback answers everything locally and never contacts a model service: it checks the harness.
// --provider deepseek-local (repair mode only) builds the same requests from Pi's catalog model and answers them here.
// --provider deepseek uses Pi's catalog model deepseek/deepseek-flash through the environment's network proxy and
// requires --max-requests, --max-minutes and --max-cost-usd; the run stops before a unit that would start past any
// of them. Up to --concurrency units run at once, so at most that many units can finish past a limit.
// --unit-minutes, 10 by default, stops a unit still running after that long: it settles as crashed and counts under
// timedOut, so one request that never returns cannot hold the run, and a probe it held is scored as blocked.
// --provider codex does the same with openai-codex/gpt-6-luna on the ChatGPT subscription, in writer, probes and smoke
// modes; docs/context-memory/codex-subscription.md sets up the proxy and the placeholder it copies the account ID from.
// --provider relay does the same with Pi's catalog model openai/gpt-6-luna, its address moved to --base-url, an
// OpenAI-compatible service that speaks the Responses API and whose key the environment's network proxy supplies.
// Output files hold counts, codes and timings. answers.jsonl keeps the synthetic probe replies for inspection.
// --keep-sessions keeps every session copy, notes included, for local reading; keep them out of the repository.
// --cache warm, the default, matches daily use, where every main-model turn keeps the session's prefix cached: the
// units of a run share one working directory, and one request over the same history precedes each cut's
// compactions, as a session's last turn would. Each warm-up is itself a cold request; warm-ups count against the
// limits and are reported apart. --cache cold gives each unit its own working directory, which Pi's system prompt
// ends with, so only the prompt's opening can be cached; it reproduces the first 0.5.0 provider run.

const script = fileURLToPath(import.meta.url);
const root = resolve(script, "../..");
const args = process.argv.slice(2);
function argument(name, fallback) {
	const index = args.indexOf(name);
	if (index >= 0 && args[index + 1] !== undefined) return args[index + 1];
	if (fallback !== undefined) return fallback;
	throw new Error(
		`Missing ${name}. Usage: node --experimental-strip-types ${script} --package-dir <package> --stock-root <official Pi> --output-dir <dir> --mode writer|probes|smoke|repair [--provider loopback|deepseek|deepseek-local|codex|relay --base-url https://...] [--fixtures P1,P2,P3] [--attempts 8] [--chain-attempts 4] [--cache warm|cold] [--thinking high] [--concurrency 1] [--label name] [--keep-sessions] [--unit-minutes 10] [--max-requests N --max-minutes N --max-cost-usd N]`,
	);
}

/** The note request of 0.5.3 and later, then that of v0.5.2 and earlier, which the quotation repair still carries. */
const WRITER_REQUESTS = ["Return ONLY the memory note itself", "Return ONLY one JSON object matching this schema"];
/** The catalog model each provider measures; `deepseek-local` builds deepseek-flash's requests and answers them here. */
const MEASURED = {
	deepseek: { provider: "deepseek", id: "deepseek-flash" },
	"deepseek-local": { provider: "deepseek", id: "deepseek-flash" },
	codex: { provider: "openai-codex", id: "gpt-6-luna" },
	relay: { provider: "openai", id: "gpt-6-luna" },
};
const LOOPBACK = {
	id: "bench-loopback",
	name: "Bench loopback",
	provider: "bench-loopback",
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 32_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true },
};
/**
 * The account ID from the placeholder the environment's setup script writes for Pi. Only the ID is read: in a cloud
 * session that file holds no token, and the bench never handles one.
 */
function codexAccountId() {
	const file = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
	let id;
	try {
		id = JSON.parse(readFileSync(file, "utf8"))["openai-codex"]?.accountId;
	} catch {}
	if (typeof id !== "string" || !id)
		throw new Error(`--provider codex reads the account ID from the openai-codex entry of ${file}; see docs/context-memory/codex-subscription.md`);
	return id;
}

/**
 * A unit's Codex credential. The proxy replaces Pi's Authorization header with the network secret's token, but Pi
 * first reads the account ID from that header's JWT, so it gets an unsigned one carrying only the ID. The far expiry
 * keeps Pi from trying to refresh it.
 */
function writeCodexPlaceholder(agentDir, accountId) {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
	const access = [encode({ alg: "none" }), encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }), "proxy-injected"].join(".");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "proxy-injected", expires: Date.parse("2100-01-01"), accountId } }),
		{ mode: 0o600 },
	);
}

/** The structure of a parsed answer two levels deep: keys, and for each value its kind and length. Never its text. */
/** One array item's keys and kinds, flagging what the note schema refuses: empty strings, long strings, repeated IDs. */
function itemShape(item) {
	if (Array.isArray(item)) return `array:${item.length}${new Set(item.map(String)).size < item.length ? ":repeated" : ""}`;
	if (typeof item === "string") return !item.length ? "string:empty" : item.length > 4000 ? "string:>4000" : item.length > 1000 ? "string:>1000" : "string";
	if (!item || typeof item !== "object") return typeof item;
	return `{${Object.keys(item)
		.sort()
		.map((key) => `${key}:${itemShape(item[key])}`)
		.join(",")}}`;
}

function jsonShape(value, depth) {
	if (Array.isArray(value)) {
		if (!depth || !value.length) return `array:${value.length}`;
		const items = {};
		for (const item of value) items[itemShape(item)] = (items[itemShape(item)] ?? 0) + 1;
		return { length: value.length, items };
	}
	if (!value || typeof value !== "object") return typeof value;
	if (!depth) return `object:${Object.keys(value).length}`;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonShape(item, depth - 1)]));
}

/**
 * The Responses API answers in output items: reasoning, then one or more messages, on Codex each in a phase such as
 * `commentary` or `final_answer`. As each response from a URL ending in `path` streams past Pi's own parser, records
 * its items, and for a message its phase and the shape of its JSON, or its length when it does not parse. Never the
 * text itself.
 */
function observeResponseItems(responses, path) {
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const response = await original(input, init);
		if (!String(input instanceof Request ? input.url : input).endsWith(path) || !response.body) return response;
		const items = [];
		responses.push(items);
		const decoder = new TextDecoder();
		let buffer = "";
		const consume = (text) => {
			buffer += text;
			let end;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end).trim();
				buffer = buffer.slice(end + 1);
				if (!line.startsWith("data:")) continue;
				let event;
				try {
					event = JSON.parse(line.slice(5));
				} catch {
					continue;
				}
				if (event.type !== "response.output_item.done") continue;
				const item = event.item ?? {};
				if (item.type !== "message") {
					items.push({ type: String(item.type) });
					continue;
				}
				const body = (item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text).join("");
				const text = body.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
				let json;
				try {
					json = jsonShape(JSON.parse(text), 2);
				} catch {
					json = { parsed: false, chars: text.length, opensObject: text.startsWith("{"), closesObject: text.endsWith("}") };
				}
				items.push({ type: "message", phase: item.phase ?? null, json });
			}
		};
		const observed = response.body.pipeThrough(
			new TransformStream({
				transform(chunk, controller) {
					consume(decoder.decode(chunk, { stream: true }));
					controller.enqueue(chunk);
				},
				flush() {
					consume(`${decoder.decode()}\n`);
				},
			}),
		);
		return new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers });
	};
}

/** Assistant responses one probe may produce before it is stopped and scored as having no answer. */
const PROBE_ROUNDS = 6;
const fixturesDir = join(root, "eval", "preview", "fixtures");

function readFixture(id) {
	const gold = JSON.parse(readFileSync(join(fixturesDir, id, "gold.json"), "utf8"));
	const lines = readFileSync(join(fixturesDir, id, "session.jsonl"), "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	return { gold, header: lines[0], entries: lines.slice(1) };
}

function readLines(file) {
	return readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
}

function writeLines(file, lines) {
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

/** The note sections a checkpoint stores; each is an array of facts with sources and an optional quote. */
const NOTE_SECTIONS = ["instructions", "failedPaths", "reasons", "state", "nextSteps", "files", "gaps"];

/** UTF-8 bytes the next compaction condenses: the latest note, if any, and every message after it. */
function condensedBytes(lines) {
	const entries = lines.slice(1);
	const last = entries.findLastIndex((entry) => entry.type === "compaction");
	const previous = last >= 0 && entries[last].details?.note ? Buffer.byteLength(JSON.stringify(entries[last].details.note)) : 0;
	return entries
		.slice(last + 1)
		.filter((entry) => entry.type === "message")
		.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.message)), previous);
}

/** Size, section counts and cited IDs of a committed note; never its text. */
function noteShape(note, contextBytes) {
	const items = NOTE_SECTIONS.flatMap((section) => (Array.isArray(note[section]) ? note[section] : []));
	const bytes = Buffer.byteLength(JSON.stringify(note));
	return {
		bytes,
		contextBytes,
		ratio: contextBytes ? Number((bytes / contextBytes).toFixed(4)) : null,
		facts: Object.fromEntries(NOTE_SECTIONS.map((section) => [section, Array.isArray(note[section]) ? note[section].length : 0])),
		quoted: items.filter((item) => typeof item?.quote === "string").length,
		sources: [...new Set(items.flatMap((item) => (Array.isArray(item?.sources) ? item.sources : [])))],
	};
}

// ---------------------------------------------------------------------------------------------------------
// Worker: one compaction or one probe on one session copy, in its own process and agent directory.
// ---------------------------------------------------------------------------------------------------------

function answerText(expected) {
	if (expected.type === "text") return expected.accept[0];
	if (expected.type === "choice") return `option ${expected.value}`;
	return String(expected.value);
}

/** A faithful note from the gold files: every answer up to this cut, cited to its first evidence entry. */
function goldNote(gold, cutIndex, readable) {
	const cut = gold.checkpoints[cutIndex].afterEntryId;
	const seen = new Set();
	const facts = [];
	for (const probe of gold.probes) {
		const index = gold.checkpoints.findIndex((checkpoint) => checkpoint.id === probe.checkpoint);
		if (index > cutIndex || probe.expected.type === "unknown" || seen.has(probe.prompt)) continue;
		const source = probe.evidence.find((id) => readable.has(id));
		if (!source) continue;
		seen.add(probe.prompt);
		facts.push({ text: `${probe.prompt} ${answerText(probe.expected)}.`, sources: [source] });
	}
	return {
		instructions: [],
		failedPaths: [],
		reasons: facts.slice(0, 40),
		state: [{ text: `Gold checkpoint ${cutIndex + 1} of ${gold.id}.`, sources: [cut] }],
		nextSteps: [{ text: "Continue the task from the latest user request.", sources: [cut] }],
		files: [],
		gaps: [],
	};
}

async function worker() {
	const action = JSON.parse(Buffer.from(argument("--action"), "base64url").toString("utf8"));
	const packageDir = resolve(argument("--package-dir"));
	const stockRoot = resolve(argument("--stock-root"));
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const cwd = action.cwd;
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	// Codex tries a WebSocket first, which the environment's proxy does not carry.
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: [packageDir], cacheWarming: "off", defaultTools: [], compaction: { keepRecentTokens: 0 }, ...(action.provider === "codex" ? { transport: "sse" } : {}) }),
	);
	let commandOutput;
	const diagnostics = [];
	for (const level of ["log", "warn", "error"]) {
		const original = console[level].bind(console);
		console[level] = (...parts) => {
			const text = parts.map(String).join(" ");
			if (commandOutput) commandOutput.push(text);
			else if (!text.includes("Source-linked compaction")) original(...parts);
		};
	}
	const stock = await import(pathToFileURL(join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);

	// Loopback: the gold writer for scripted cuts and a fixed unknown answer for probes. In repair mode the writer's
	// first call gets the planted candidate, and only the quotation repair reaches the measured model: from here,
	// so the request is the one official Pi built for that model. `deepseek-local` answers it with the case's
	// scripted repair and never leaves this machine.
	const { gold } = readFixture(action.fixture);
	const repairSettings = [];
	let forwarded = 0;
	/** The catalog's address for the measured model, read before the bench moves it. */
	let upstream;
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const part of request) raw += part;
		const payload = JSON.parse(raw);
		const serialized = JSON.stringify(payload.messages ?? []);
		if (action.type === "repair") {
			const repair = serialized.includes("Correct the quotations of a memory candidate");
			if (repair) repairSettings.push({ thinking: payload.thinking?.type ?? null, effort: payload.reasoning_effort ?? null, maxTokens: payload.max_tokens ?? payload.max_completion_tokens ?? null, toolChoice: payload.tool_choice ?? null, tools: Array.isArray(payload.tools) ? payload.tools.length : 0 });
			if (repair && action.provider === "deepseek") {
				forwarded++;
				try {
					const answer = await fetch(`${upstream}${request.url}`, { method: "POST", headers: { "content-type": "application/json", authorization: request.headers.authorization ?? "" }, body: raw, signal: AbortSignal.timeout(600_000) });
					response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache" });
					if (answer.body) for await (const part of answer.body) response.write(part);
					response.end();
				} catch (cause) {
					if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { message: `bench forward failed: ${String(cause?.message ?? cause).slice(0, 120)}` } }));
				}
				return;
			}
			// Local answers carry no usage: only the measured repair is counted.
			const text = JSON.stringify(repair ? action.scripted : action.candidate);
			const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "bench", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.write(chunk({ role: "assistant", content: text }, null));
			response.write(chunk({}, "stop"));
			response.end("data: [DONE]\n\n");
			return;
		}
		const writer = WRITER_REQUESTS.some((marker) => serialized.includes(marker));
		const readable = new Set(
			readLines(action.sessionFile)
				.slice(1)
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.id),
		);
		const text = writer
			? JSON.stringify(goldNote(gold, action.cutIndex ?? 0, readable))
			: JSON.stringify({ status: "unknown" });
		const chunk = (delta, finish, usage) =>
			`data: ${JSON.stringify({ id: "bench", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.write(chunk({ role: "assistant", content: text }, null));
		response.write(chunk({}, "stop", { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 }));
		response.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	const runtime = await stock.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
	const measured = MEASURED[action.provider];
	const responseItems = [];
	let model;
	if (action.provider === "loopback") {
		model = { ...LOOPBACK, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
		runtime.registerProvider(model.provider, { api: model.api, apiKey: "bench-loopback-only", baseUrl: model.baseUrl, models: [model] });
	} else if (action.type === "repair") {
		// The catalog's own model, with its compatibility settings and level map; only the address moves here.
		if (action.provider === "deepseek") {
			const dispatcher = await import(pathToFileURL(join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "http-dispatcher.js")).href);
			dispatcher.configureHttpDispatcher();
		}
		upstream = runtime.getModel(measured.provider, measured.id)?.baseUrl;
		if (!upstream?.startsWith("https://")) throw new Error(`${measured.provider}/${measured.id} is not in this Pi's catalog`);
		runtime.registerProvider(measured.provider, { baseUrl: `http://127.0.0.1:${server.address().port}` });
		model = runtime.getModel(measured.provider, measured.id);
		if (!model?.baseUrl?.startsWith("http://127.0.0.1:")) throw new Error(`${measured.provider}/${measured.id} did not move to the bench's address`);
	} else {
		// The Pi CLI installs its proxy-aware dispatcher at startup; an SDK caller has to do the same.
		const dispatcher = await import(pathToFileURL(join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "http-dispatcher.js")).href);
		dispatcher.configureHttpDispatcher();
		if (action.provider === "codex") observeResponseItems(responseItems, "/codex/responses");
		if (action.provider === "relay") observeResponseItems(responseItems, "/responses");
		// The catalog's own model, with its compatibility settings and level map; only the address moves to the relay.
		if (action.provider === "relay") runtime.registerProvider(measured.provider, { baseUrl: action.baseUrl });
		model = runtime.getModel(measured.provider, measured.id);
		if (!model) throw new Error(`${measured.provider}/${measured.id} is not in this Pi's catalog`);
		if (action.provider === "relay" && model.baseUrl !== action.baseUrl) throw new Error(`${measured.provider}/${measured.id} did not move to the relay's address`);
	}
	const settingsManager = stock.SettingsManager.create(cwd, agentDir);
	const loader = new stock.DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	if (loaded.errors.length || !loaded.extensions.some((extension) => extension.path.startsWith(packageDir)))
		throw new Error(`The preview package did not load: ${JSON.stringify(loaded.errors).slice(0, 300)}`);
	const sessionManager = stock.SessionManager.open(action.sessionFile);
	const thinkingLevel = action.provider === "loopback" ? "off" : action.thinking;
	const { session } = await stock.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel, sessionManager, settingsManager, resourceLoader: loader, noTools: "builtin" });
	await session.bindExtensions({ onError: (error) => diagnostics.push(String(error?.message ?? error).slice(0, 200)) });
	const status = async () => {
		commandOutput = [];
		try {
			await session.prompt("/compaction-status");
			return JSON.parse(commandOutput.join("\n"));
		} catch {
			return {};
		} finally {
			commandOutput = undefined;
		}
	};

	let result;
	if (action.type === "compact" || action.type === "repair") {
		const contextBytes = condensedBytes(readLines(action.sessionFile));
		const started = performance.now();
		let error;
		try {
			await session.compact();
		} catch (cause) {
			error = String(cause?.message ?? cause).slice(0, 200);
		}
		const after = await status();
		const writer = after.lastWriter ?? {};
		result = {
			ok: error === undefined && after.lastCompaction?.diskConfirmed === true,
			...(error ? { error } : {}),
			code: after.code ?? null,
			ms: Math.round(performance.now() - started),
			writerCalls: writer.writerCalls ?? 0,
			phases: (writer.writerCallDetails ?? []).map((call) => call.phase),
			// Per call: the effort asked for, the reasoning the request carried, how it ended, the schema envelope
			// removed from its note and its tokens.
			calls: (writer.writerCallDetails ?? []).map((call) => ({ phase: call.phase, ms: call.ms ?? null, effort: call.effort ?? null, sent: call.sent ?? null, stopReason: call.stopReason ?? null, envelope: call.envelope ?? null, input: call.usage?.input ?? null, cacheRead: call.usage?.cacheRead ?? null, output: call.usage?.output ?? null, reasoning: call.usage?.reasoning ?? null })),
			repairKind: writer.repairKind ?? null,
			quotations: writer.quotations ?? null,
			scope: writer.scope ?? null,
			quotationRepair: writer.quotationRepair ?? null,
			toolCalls: writer.toolCallResponses ?? 0,
			toolCallDeclined: writer.toolCallDeclined ?? false,
			usage: writer.usage ?? null,
			pauseMs: after.lastCompaction?.pauseMs ?? null,
			...(action.provider === "codex" ? { codexResponses: responseItems } : {}),
			...(action.provider === "relay" ? { relayResponses: responseItems } : {}),
		};
		if (result.ok) {
			const note = readLines(action.sessionFile).findLast((entry) => entry.type === "compaction" && entry.details?.kind === "pi-context-memory")?.details.note;
			if (note) result.note = noteShape(note, contextBytes);
			// Synthetic text, scored by the parent and never written to the run's files.
			if (note && action.type === "repair") result.committedNote = note;
		}
		if (action.type === "repair") Object.assign(result, { repairSettings, forwarded });
	} else {
		// "session" keeps the session's own tools, so a warm-up request carries the writer's exact prefix.
		if (action.condition !== "session") session.setActiveToolsByName(action.condition === "history" ? ["context_history"] : []);
		const activeTools = session.agent.state.tools.map((tool) => tool.name);
		const before = sessionManager.getBranch().length;
		let rounds = 0;
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		session.subscribe((event) => {
			if (event.type !== "message_end" || event.message?.role !== "assistant") return;
			rounds++;
			const reported = event.message.usage;
			if (reported) {
				usage.input += reported.input ?? 0;
				usage.output += reported.output ?? 0;
				usage.cacheRead += reported.cacheRead ?? 0;
				usage.cacheWrite += reported.cacheWrite ?? 0;
				usage.cost += reported.cost?.total ?? 0;
			}
			if (rounds >= PROBE_ROUNDS) session.abort();
		});
		let error;
		try {
			await session.prompt(action.prompt);
		} catch (cause) {
			error = String(cause?.message ?? cause).slice(0, 200);
		}
		const added = sessionManager.getBranch().slice(before);
		const assistants = added.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		const last = assistants.at(-1)?.message;
		const calls = assistants.flatMap((entry) =>
			entry.message.content.filter((block) => block.type === "toolCall" && block.name === "context_history").map((block) => block.arguments?.operation ?? "invalid"),
		);
		const after = await status();
		result = {
			activeTools,
			reached: rounds > 0,
			...(error ? { error } : {}),
			code: after.code ?? null,
			rounds,
			roundLimit: rounds >= PROBE_ROUNDS,
			stopReason: last?.stopReason ?? null,
			...(last?.errorMessage ? { errorMessage: String(last.errorMessage).slice(0, 300) } : {}),
			reply: last && last.stopReason === "stop" ? last.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : undefined,
			history: { search: calls.filter((op) => op === "search").length, read: calls.filter((op) => op === "read").length, list: calls.filter((op) => op === "list").length, other: calls.filter((op) => !["search", "read", "list"].includes(op)).length },
			usage,
		};
	}
	session.dispose();
	server.close();
	process.stdout.write(`BENCH_RESULT ${JSON.stringify({ ...result, diagnostics })}\n`);
	process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------
// Parent: chains, units, limits and the report.
// ---------------------------------------------------------------------------------------------------------

async function parent() {
	const { scoreProbe, summarizePreview } = await import(pathToFileURL(join(root, "eval", "preview", "scorer.ts")).href);
	const { ANSWER_CONTRACT } = await import(pathToFileURL(join(root, "eval", "preview", "schema.ts")).href);
	const { REPAIR_CASES_VERSION, repairCases, scoreRepair, summarizeRepairs } = await import(pathToFileURL(join(root, "eval", "preview", "repair.ts")).href);
	const packageDir = resolve(argument("--package-dir"));
	const stockRoot = resolve(argument("--stock-root"));
	const outputDir = resolve(argument("--output-dir"));
	const mode = argument("--mode");
	const provider = argument("--provider", "loopback");
	const fixtures = argument("--fixtures", "P1,P2,P3").split(",");
	const attempts = Number(argument("--attempts", "8"));
	const thinking = argument("--thinking", "high");
	const concurrency = Number(argument("--concurrency", "1"));
	const chainAttempts = Number(argument("--chain-attempts", "4"));
	const cache = argument("--cache", "warm");
	const label = argument("--label", "run");
	const unitMinutes = Number(argument("--unit-minutes", "10"));
	if (!(unitMinutes > 0)) throw new Error("--unit-minutes must be positive");
	if (!["writer", "probes", "smoke", "repair"].includes(mode)) throw new Error("--mode must be writer, probes, smoke or repair");
	if (!["loopback", "deepseek", "deepseek-local", "codex", "relay"].includes(provider)) throw new Error("--provider must be loopback, deepseek, deepseek-local, codex or relay");
	if (provider === "deepseek-local" && mode !== "repair") throw new Error("--provider deepseek-local serves only --mode repair");
	// Repair mode answers the writer's first call here in Chat Completions; Codex speaks the Responses API.
	if (provider === "codex" && mode === "repair") throw new Error("--provider codex does not serve --mode repair");
	if (provider === "relay" && mode === "repair") throw new Error("--provider relay does not serve --mode repair");
	const baseUrl = provider === "relay" ? argument("--base-url", "").replace(/\/+$/, "") : undefined;
	if (provider === "relay" && !baseUrl.startsWith("https://")) throw new Error("--provider relay needs --base-url https://...");
	if (!["cold", "warm"].includes(cache)) throw new Error("--cache must be cold or warm");
	const remote = provider === "deepseek" || provider === "codex" || provider === "relay";
	const limits = !remote
		? { requests: Number.POSITIVE_INFINITY, minutes: Number.POSITIVE_INFINITY, costUsd: Number.POSITIVE_INFINITY }
		: { requests: Number(argument("--max-requests")), minutes: Number(argument("--max-minutes")), costUsd: Number(argument("--max-cost-usd")) };
	const codexAccount = provider === "codex" ? codexAccountId() : undefined;
	for (const [name, value] of Object.entries(limits))
		if (!(value > 0)) throw new Error(`--max-${name} must be positive for a provider run`);
	const build = JSON.parse(readFileSync(join(packageDir, "preview-build.json"), "utf8"));
	const hostVersion = JSON.parse(readFileSync(join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
	const runDir = join(outputDir, label);
	rmSync(runDir, { recursive: true, force: true });
	mkdirSync(runDir, { recursive: true });
	const started = Date.now();
	const used = { requests: 0, costUsd: 0, units: 0, unstarted: 0, timedOut: 0, warmups: 0, warmupCostUsd: 0 };
	const exhausted = () =>
		used.requests >= limits.requests || used.costUsd >= limits.costUsd || (Date.now() - started) / 60_000 >= limits.minutes;
	const record = (file, row) => appendFileSync(join(runDir, file), `${JSON.stringify(row)}\n`);

	const environment = (agentDir) => {
		const value = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: join(agentDir, "home"),
			LANG: "C.UTF-8",
			CI: "1",
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "0",
			PI_TELEMETRY: "0",
			PI_SKIP_VERSION_CHECK: "1",
		};
		// Answered on this machine: Pi still needs a key to build the request, and gets one that opens nothing.
		if (provider === "deepseek-local") value.DEEPSEEK_API_KEY = "bench-local-only";
		if (remote) {
			// The proxy injects the real key; Pi receives only a placeholder, Codex's in the unit's auth.json.
			if (provider === "deepseek") value.DEEPSEEK_API_KEY = "proxy-injected";
			if (provider === "relay") value.OPENAI_API_KEY = "proxy-injected";
			value.NODE_USE_ENV_PROXY = "1";
			for (const name of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"])
				if (process.env[name]) value[name] = process.env[name];
		}
		return value;
	};

	let sequence = 0;
	async function run(action) {
		const id = String(++sequence).padStart(4, "0");
		const agentDir = join(runDir, "agents", id);
		// Pi's system prompt ends with the working directory, so a directory per unit gives every request its own
		// prefix after a few hundred tokens; a warm run shares one directory, as one user's session does.
		const cwd = join(runDir, "cwd", cache === "warm" ? "shared" : id);
		if (codexAccount) writeCodexPlaceholder(agentDir, codexAccount);
		const encoded = Buffer.from(JSON.stringify({ ...action, cwd, ...(action.provider === "relay" ? { baseUrl } : {}) })).toString("base64url");
		const child = spawn(process.execPath, [script, "--worker", "--action", encoded, "--package-dir", packageDir, "--stock-root", stockRoot], { cwd: runDir, env: environment(agentDir), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (part) => (stdout += part));
		child.stderr.on("data", (part) => (stderr += part));
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, unitMinutes * 60_000);
		const [code] = await once(child, "close");
		clearTimeout(timer);
		rmSync(agentDir, { recursive: true, force: true });
		if (timedOut) used.timedOut++;
		const line = stdout.split("\n").find((item) => item.startsWith("BENCH_RESULT "));
		if (!line) return { crashed: true, ...(timedOut ? { timedOut } : {}), exitCode: code, stderr: stderr.slice(-600) };
		return JSON.parse(line.slice("BENCH_RESULT ".length));
	}

	/** Measured requests and catalog cost, counted as each unit settles. */
	function spend(result, measured) {
		used.units++;
		if (!measured) return;
		used.requests += result.forwarded ?? result.writerCalls ?? result.rounds ?? 0;
		used.costUsd += result.usage?.cost?.total ?? result.usage?.cost ?? 0;
	}

	/**
	 * In a warm run, one request over a copy of `file` with the session's own tools, as the main model's last turn
	 * would be, so that the writer's attempts at this cut find the history's prefix cached.
	 */
	async function warm(fixture, cut, file) {
		if (cache !== "warm" || exhausted()) return;
		const result = await run({ type: "probe", provider, fixture: fixture.gold.id, sessionFile: copy(file, `${fixture.gold.id}-cut${cut + 1}-warm`), condition: "session", prompt: "Reply with the single word OK.", thinking });
		spend(result, provider !== "loopback");
		used.warmups++;
		used.warmupCostUsd += result.usage?.cost ?? 0;
		record("warmups.jsonl", { fixture: fixture.gold.id, cut: cut + 1, reached: result.reached ?? false, rounds: result.rounds ?? 0, crashed: result.crashed ?? false, usage: result.usage ?? null });
	}

	async function pool(units, work) {
		const queue = [...units];
		const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
			while (queue.length) {
				const unit = queue.shift();
				if (exhausted()) {
					used.unstarted++;
					continue;
				}
				await work(unit);
			}
		});
		await Promise.all(runners);
	}

	const position = (fixture, id) => fixture.entries.findIndex((entry) => entry.id === id);
	/** The fixture's entries after cut `cut` up to and including cut `cut + 1`, the first re-parented on `leaf`. */
	function segment(fixture, cut, leaf) {
		const from = cut < 0 ? 0 : position(fixture, fixture.gold.checkpoints[cut].afterEntryId) + 1;
		const to = position(fixture, fixture.gold.checkpoints[cut + 1].afterEntryId) + 1;
		const next = fixture.entries.slice(from, to).map((entry) => ({ ...entry }));
		next[0].parentId = leaf;
		return next;
	}

	/**
	 * Compact `file` at checkpoint `cut`, retrying a refused measured writer up to `chainAttempts` attempts in all, as
	 * a user retries /compact. Returns every attempt; the last one decides.
	 */
	async function compactAt(fixture, cut, writer, file) {
		const results = [];
		do {
			const result = await run({ type: "compact", provider: writer, fixture: fixture.gold.id, cutIndex: cut, sessionFile: file, thinking });
			spend(result, writer !== "loopback");
			results.push(result);
		} while (!results.at(-1).ok && writer !== "loopback" && results.length < chainAttempts && !exhausted());
		return results;
	}

	/** A session file holding the fixture up to cut k, with every earlier cut compacted by the loopback writer. */
	async function base(fixture, k) {
		mkdirSync(join(runDir, "chains"), { recursive: true });
		const file = join(runDir, "chains", `${fixture.gold.id}-base-cut${k + 1}.jsonl`);
		let lines = [fixture.header, ...segment(fixture, -1, null)];
		for (let cut = 0; cut < k; cut++) {
			writeLines(file, lines);
			const results = await compactAt(fixture, cut, "loopback", file);
			if (!results.at(-1).ok) throw new Error(`The loopback writer could not compact ${fixture.gold.id} cut ${cut + 1}`);
			lines = readLines(file);
			lines = [...lines, ...segment(fixture, cut, lines.at(-1).id)];
		}
		writeLines(file, lines);
		return file;
	}

	/** A plain copy: entries, the header and so every hash stay as they were. */
	function copy(file, name) {
		const target = join(runDir, "copies", `${name}.jsonl`);
		mkdirSync(join(runDir, "copies"), { recursive: true });
		copyFileSync(file, target);
		return target;
	}

	/** Gold answers a note cites: those first asked at this cut, and those from earlier cuts carried forward. */
	function noteRow(fixture, k, note) {
		if (!note) return null;
		const { sources, ...shape } = note;
		const cited = new Set(sources);
		const order = new Map(fixture.gold.checkpoints.map((checkpoint, index) => [checkpoint.id, index]));
		const answerable = fixture.gold.probes.filter((probe) => probe.expected.type !== "unknown");
		const count = (list) => ({ cited: list.filter((probe) => probe.evidence.some((id) => cited.has(id))).length, total: list.length });
		return {
			...shape,
			cited: cited.size,
			coverage: { current: count(answerable.filter((probe) => order.get(probe.checkpoint) === k)), carried: count(answerable.filter((probe) => order.get(probe.checkpoint) < k)) },
		};
	}

	/** Medians of note size and ratio over committed notes, and gold coverage summed over them. */
	function noteSummary(list) {
		const notes = list.filter((row) => row.ok && row.note).map((row) => row.note);
		const median = (values) => {
			const sorted = [...values].sort((a, b) => a - b);
			return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
		};
		const total = (pick) => notes.reduce((sum, note) => ({ cited: sum.cited + pick(note).cited, total: sum.total + pick(note).total }), { cited: 0, total: 0 });
		return {
			measured: notes.length,
			bytesMedian: median(notes.map((note) => note.bytes)),
			contextBytesMedian: median(notes.map((note) => note.contextBytes)),
			ratioMedian: median(notes.map((note) => note.ratio)),
			factsMedian: median(notes.map((note) => Object.values(note.facts).reduce((sum, value) => sum + value, 0))),
			quotedMedian: median(notes.map((note) => note.quoted)),
			coverage: { current: total((note) => note.coverage.current), carried: total((note) => note.coverage.carried) },
		};
	}

	const shown = Object.fromEntries(Object.entries(limits).map(([name, value]) => [name, Number.isFinite(value) ? value : "unlimited"]));
	const report = { label, mode, provider, model: provider === "loopback" ? LOOPBACK.id : `${MEASURED[provider].provider}/${MEASURED[provider].id}`, ...(baseUrl ? { endpoint: new URL(baseUrl).host } : {}), thinking, cache, ...(mode === "probes" ? { chainAttempts } : {}), build: build.buildId ?? build.build ?? null, piVersion: hostVersion, fixtures, limits: shown };

	if (mode === "smoke") {
		// One small request through the history conversion: the opening turn of P1 and a one-word reply.
		const fixture = readFixture("P1");
		const end = fixture.entries.findIndex((entry) => entry.message?.role === "assistant" && entry.message.stopReason === "stop");
		const file = join(runDir, "smoke.jsonl");
		writeLines(file, [fixture.header, ...fixture.entries.slice(0, end + 1)]);
		const result = await run({ type: "probe", provider, fixture: "P1", sessionFile: file, condition: "none", prompt: "Reply with the single word OK.", thinking: "low" });
		spend(result, provider !== "loopback");
		report.smoke = { reached: result.reached, stopReason: result.stopReason, errorMessage: result.errorMessage ?? null, reply: result.reply?.slice(0, 40), error: result.error ?? null, crashed: result.crashed ?? false, ...(result.crashed ? { exitCode: result.exitCode, stderr: result.stderr } : {}), usage: result.usage ?? null, diagnostics: result.diagnostics ?? [] };
	}

	if (mode === "writer") {
		const rows = [];
		for (const id of fixtures) {
			const fixture = readFixture(id);
			for (let k = 0; k < fixture.gold.checkpoints.length; k++) {
				if (exhausted()) {
					used.unstarted += attempts;
					continue;
				}
				const baseFile = await base(fixture, k);
				await warm(fixture, k, baseFile);
				await pool(
					Array.from({ length: attempts }, (_, attempt) => attempt),
					async (attempt) => {
						const file = copy(baseFile, `${id}-cut${k + 1}-attempt${attempt + 1}`);
						const result = await run({ type: "compact", provider, fixture: id, cutIndex: k, sessionFile: file, thinking });
						spend(result, provider !== "loopback");
						const row = { fixture: id, cut: k + 1, attempt: attempt + 1, ...result, note: noteRow(fixture, k, result.note) };
						delete row.diagnostics;
						rows.push(row);
						record("writer.jsonl", row);
					},
				);
			}
		}
		const group = (list) => {
			const codes = {};
			for (const row of list) if (!row.ok) codes[row.code ?? (row.crashed ? "CRASHED" : "UNKNOWN")] = (codes[row.code ?? (row.crashed ? "CRASHED" : "UNKNOWN")] ?? 0) + 1;
			const sum = (pick) => list.reduce((total, row) => total + (pick(row) ?? 0), 0);
			const pauses = list.filter((row) => row.ok && row.pauseMs !== null).map((row) => row.pauseMs).sort((a, b) => a - b);
			return {
				attempts: list.length,
				committed: list.filter((row) => row.ok).length,
				refusedByCode: codes,
				firstPassQuotationFailures: list.filter((row) => row.quotations).length,
				quotationClasses: { elsewhere: sum((row) => row.quotations?.elsewhere), format: sum((row) => row.quotations?.format), absent: sum((row) => row.quotations?.absent) },
				// Scope refusals' citations: IDs on no entry, entries without readable text and their kinds; counts only.
				scopeCitations: {
					refusals: list.filter((row) => row.scope).length,
					missing: sum((row) => row.scope?.missing),
					unreadable: sum((row) => row.scope?.unreadable),
					inSupersedes: sum((row) => row.scope?.inSupersedes),
					unreadableKinds: list.reduce((kinds, row) => {
						for (const [kind, count] of Object.entries(row.scope?.unreadableKinds ?? {})) kinds[kind] = (kinds[kind] ?? 0) + count;
						return kinds;
					}, {}),
				},
				repairs: {
					quotation: list.filter((row) => row.repairKind === "quotation").length,
					size: list.filter((row) => row.repairKind === "size").length,
				},
				toolCallsDeclined: list.filter((row) => row.toolCallDeclined).length,
				repairedAndCommitted: list.filter((row) => row.repairKind && row.ok).length,
				toolCallResponses: sum((row) => row.toolCalls),
				// Writer answers whose note arrived inside a schema envelope, by shape, and the attempts that then committed.
				envelopes: {
					type: sum((row) => row.calls?.filter((call) => call.envelope === "type").length),
					schema: sum((row) => row.calls?.filter((call) => call.envelope === "schema").length),
					committed: list.filter((row) => row.ok && row.calls?.some((call) => call.envelope)).length,
				},
				repairOutcome: { requoted: sum((row) => row.quotationRepair?.requoted), unquoted: sum((row) => row.quotationRepair?.unquoted), dropped: sum((row) => row.quotationRepair?.dropped), droppedFrom: Object.fromEntries(NOTE_SECTIONS.map((section) => [section, sum((row) => row.quotationRepair?.droppedFrom?.[section])]).filter(([, count]) => count > 0)) },
				writerCalls: sum((row) => row.writerCalls),
				usage: { input: sum((row) => row.usage?.input), output: sum((row) => row.usage?.output), cacheRead: sum((row) => row.usage?.cacheRead), costUsd: Number(sum((row) => row.usage?.cost?.total).toFixed(4)) },
				pauseMsMedian: pauses.length ? pauses[Math.floor(pauses.length / 2)] : null,
				notes: noteSummary(list),
			};
		};
		report.writer = {
			overall: group(rows),
			byCut: Object.fromEntries([...new Set(rows.map((row) => `${row.fixture}-cut${row.cut}`))].map((key) => [key, group(rows.filter((row) => `${row.fixture}-cut${row.cut}` === key))])),
		};
	}

	if (mode === "repair") {
		// Every case at every cut, --attempts times: the planted candidate is the writer's first answer, and the
		// measured model answers only the repair. Rows keep scores, codes and call settings, never note text.
		const rows = [];
		const scores = [];
		const skipped = [];
		// The repair carries no session prefix, but every repair request opens with the same rules. The run's first
		// unit goes alone, so that a provider that caches prefixes has them before the rest arrive concurrently.
		let primed = false;
		for (const id of fixtures) {
			const fixture = readFixture(id);
			for (let k = 0; k < fixture.gold.checkpoints.length; k++) {
				const baseFile = await base(fixture, k);
				const branch = readLines(baseFile).slice(1);
				const readable = new Set(branch.filter((entry) => entry.type === "message").map((entry) => entry.id));
				const set = repairCases({ fixture: id, cut: k + 1, base: goldNote(fixture.gold, k, readable), branch });
				for (const item of set.skipped) skipped.push({ fixture: id, cut: k + 1, ...item });
				const units = set.cases.flatMap((repairCase) => Array.from({ length: attempts }, (_, attempt) => ({ repairCase, attempt })));
				const work = async ({ repairCase, attempt }) => {
					const file = copy(baseFile, `${repairCase.id}-attempt${attempt + 1}`);
					const result = await run({ type: "repair", provider, fixture: id, cutIndex: k, sessionFile: file, thinking, candidate: repairCase.candidate, scripted: repairCase.scripted });
					spend(result, provider === "deepseek");
					const score = scoreRepair(repairCase, { committed: result.ok === true, code: result.code ?? (result.crashed ? "CRASHED" : null), note: result.committedNote }, branch);
					scores.push(score);
					const row = { case: repairCase.id, template: repairCase.template, fixture: id, cut: k + 1, attempt: attempt + 1, ok: result.ok ?? false, code: result.code ?? null, crashed: result.crashed ?? false, writerCalls: result.writerCalls ?? 0, repairKind: result.repairKind ?? null, quotations: result.quotations ?? null, scope: result.scope ?? null, quotationRepair: result.quotationRepair ?? null, calls: result.calls ?? [], repairSettings: result.repairSettings ?? [], forwarded: result.forwarded ?? 0, pauseMs: result.pauseMs ?? null, usage: result.usage ?? null, score: { pass: score.pass, silentLoss: score.silentLoss, promoted: score.promoted, keptUnsupported: score.keptUnsupported, facts: score.facts } };
					rows.push(row);
					record("repairs.jsonl", row);
				};
				if (!primed && units.length) {
					primed = true;
					await work(units.shift());
				}
				await pool(units, work);
			}
		}
		const repairCalls = rows.flatMap((row) => row.calls.filter((call) => call.phase === "repair"));
		const ordered = (values) => values.filter((value) => typeof value === "number").sort((a, b) => a - b);
		const at = (values, share) => (values.length ? values[Math.min(values.length - 1, Math.floor(values.length * share))] : null);
		const stats = (values) => {
			const sorted = ordered(values);
			return { reported: sorted.length, median: at(sorted, 0.5), p90: at(sorted, 0.9), max: sorted.at(-1) ?? null };
		};
		const tally = (values) => values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});
		report.repair = {
			cases: REPAIR_CASES_VERSION,
			attemptsPerCase: attempts,
			skipped,
			scores: summarizeRepairs(scores),
			repairCalls: {
				calls: repairCalls.length,
				stopReasons: tally(repairCalls.map((call) => call.stopReason ?? "unknown")),
				requested: tally(repairCalls.map((call) => call.effort ?? "unknown")),
				sent: tally(rows.flatMap((row) => row.repairSettings).map((item) => JSON.stringify(item))),
				outputTokens: stats(repairCalls.map((call) => call.output)),
				reasoningTokens: stats(repairCalls.map((call) => call.reasoning)),
				ms: stats(repairCalls.map((call) => call.ms)),
				// Share of the repair calls' input the provider reported as read from its cache.
				cacheReadShare: (() => {
					const read = repairCalls.reduce((sum, call) => sum + (call.cacheRead ?? 0), 0);
					const total = read + repairCalls.reduce((sum, call) => sum + (call.input ?? 0), 0);
					return total ? Number((read / total).toFixed(4)) : null;
				})(),
				costUsd: Number(rows.reduce((sum, row) => sum + (row.usage?.cost?.total ?? 0), 0).toFixed(4)),
			},
		};
	}

	if (mode === "probes") {
		const scores = { history: [], none: [] };
		const calls = { history: { questions: 0, search: 0, read: 0, list: 0, other: 0 }, none: { questions: 0, search: 0, read: 0, list: 0, other: 0 } };
		const missed = { history: { cited: [], uncited: [] }, none: { cited: [], uncited: [] } };
		const compactions = [];
		for (const id of fixtures) {
			const fixture = readFixture(id);
			const ids = new Set(fixture.entries.map((entry) => entry.id));
			mkdirSync(join(runDir, "chains"), { recursive: true });
			// One chain per fixture, compacted by the measured writer cut after cut, as a user would continue it.
			const file = join(runDir, "chains", `${id}-measured.jsonl`);
			let lines = [fixture.header, ...segment(fixture, -1, null)];
			let broken = false;
			for (let k = 0; k < fixture.gold.checkpoints.length; k++) {
				const probes = fixture.gold.probes.filter((probe) => probe.checkpoint === fixture.gold.checkpoints[k].id);
				if (broken || exhausted()) {
					if (broken) for (const probe of probes) for (const condition of ["history", "none"]) scores[condition].push(scoreProbe(fixture.gold, probe, undefined, ids));
					else used.unstarted += probes.length * 2;
					continue;
				}
				writeLines(file, lines);
				await warm(fixture, k, file);
				const results = await compactAt(fixture, k, provider, file);
				results.forEach((result, attempt) => {
					const row = { fixture: id, cut: k + 1, attempt: attempt + 1, ok: result.ok, code: result.code, writerCalls: result.writerCalls, repairKind: result.repairKind, quotations: result.quotations, scope: result.scope ?? null, quotationRepair: result.quotationRepair, toolCalls: result.toolCalls ?? 0, toolCallDeclined: result.toolCallDeclined ?? false, calls: result.calls ?? [], pauseMs: result.pauseMs, usage: result.usage, crashed: result.crashed ?? false, note: noteRow(fixture, k, result.note) };
					compactions.push(row);
					record("compactions.jsonl", row);
				});
				if (!results.at(-1).ok) {
					// A blocked checkpoint blocks its probes and every later one in this chain; they are scored as blocked.
					broken = true;
					for (const probe of probes) for (const condition of ["history", "none"]) scores[condition].push(scoreProbe(fixture.gold, probe, undefined, ids));
					continue;
				}
				lines = readLines(file);
				const snapshot = join(runDir, "chains", `${id}-measured-cut${k + 1}.jsonl`);
				writeLines(snapshot, lines);
				const cited = new Set(
					lines
						.filter((entry) => entry.type === "compaction" && entry.details?.kind === "pi-context-memory")
						.flatMap((entry) => Object.values(entry.details.note).flatMap((items) => (Array.isArray(items) ? items.flatMap((item) => item?.sources ?? []) : []))),
				);
				const units = probes.flatMap((probe) => ["history", "none"].map((condition) => ({ probe, condition })));
				await pool(units, async ({ probe, condition }) => {
					const copied = copy(snapshot, `${probe.id}-${condition}`);
					const result = await run({ type: "probe", provider, fixture: id, sessionFile: copied, condition, prompt: `${probe.prompt}\n\n${ANSWER_CONTRACT}`, thinking });
					spend(result, provider !== "loopback");
					const score = scoreProbe(fixture.gold, probe, result.reached ? (result.reply ?? "") : undefined, ids);
					scores[condition].push(score);
					calls[condition].questions++;
					for (const op of ["search", "read", "list", "other"]) calls[condition][op] += result.history?.[op] ?? 0;
					(probe.evidence.some((entry) => cited.has(entry)) || probe.expected.type === "unknown" ? missed[condition].cited : missed[condition].uncited).push(score);
					record("probes.jsonl", { probe: probe.id, kind: probe.kind, condition, activeTools: result.activeTools, outcome: score.outcome, supported: score.supported, rounds: result.rounds, roundLimit: result.roundLimit, history: result.history, code: result.code, crashed: result.crashed ?? false, usage: result.usage });
					record("answers.jsonl", { probe: probe.id, condition, reply: result.reply ?? null, error: result.error ?? null, errorMessage: result.errorMessage ?? null });
				});
				if (k + 1 < fixture.gold.checkpoints.length) lines = [...lines, ...segment(fixture, k, lines.at(-1).id)];
			}
		}
		const rate = (list) => ({ planned: list.length, passed: list.filter((row) => row.pass).length });
		report.probes = {
			compactions: { attempts: compactions.length, committed: compactions.filter((row) => row.ok).length, refusedByCode: compactions.filter((row) => !row.ok).reduce((codes, row) => ({ ...codes, [row.code ?? "UNKNOWN"]: (codes[row.code ?? "UNKNOWN"] ?? 0) + 1 }), {}), toolCallResponses: compactions.reduce((sum, row) => sum + (row.toolCalls ?? 0), 0), toolCallsDeclined: compactions.filter((row) => row.toolCallDeclined).length, notes: noteSummary(compactions) },
			history: summarizePreview(scores.history),
			none: summarizePreview(scores.none),
			callsPerQuestion: Object.fromEntries(
				Object.entries(calls).map(([condition, value]) => [condition, { questions: value.questions, total: value.search + value.read + value.list + value.other, ...value }]),
			),
			missedEntry: Object.fromEntries(Object.entries(missed).map(([condition, value]) => [condition, { cited: rate(value.cited), uncited: rate(value.uncited) }])),
		};
	}

	report.used = { ...used, costUsd: Number(used.costUsd.toFixed(4)), warmupCostUsd: Number(used.warmupCostUsd.toFixed(4)), minutes: Number(((Date.now() - started) / 60_000).toFixed(1)) };
	writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
	if (!args.includes("--keep-sessions")) rmSync(join(runDir, "copies"), { recursive: true, force: true });
	rmSync(join(runDir, "cwd"), { recursive: true, force: true });
	process.stdout.write(`${JSON.stringify(report.used)}\nSummary: ${join(runDir, "summary.json")}\n`);
	if (!existsSync(join(runDir, "summary.json"))) process.exit(1);
}

if (args.includes("--worker")) await worker();
else await parent();
