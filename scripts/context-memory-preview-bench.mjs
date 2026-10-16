import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
//
// --provider loopback answers everything locally and never contacts a model service: it checks the harness.
// --provider deepseek uses Pi's catalog model deepseek/deepseek-flash through the environment's network proxy and
// requires --max-requests, --max-minutes and --max-cost-usd; the run stops before a unit that would start past any
// of them. Up to --concurrency units run at once, so at most that many units can finish past a limit.
// Output files hold counts, codes and timings. answers.jsonl keeps the synthetic probe replies for inspection.
// --keep-sessions keeps every session copy, notes included, for local reading; keep them out of the repository.

const script = fileURLToPath(import.meta.url);
const root = resolve(script, "../..");
const args = process.argv.slice(2);
function argument(name, fallback) {
	const index = args.indexOf(name);
	if (index >= 0 && args[index + 1] !== undefined) return args[index + 1];
	if (fallback !== undefined) return fallback;
	throw new Error(
		`Missing ${name}. Usage: node --experimental-strip-types ${script} --package-dir <package> --stock-root <official Pi> --output-dir <dir> --mode writer|probes|smoke [--provider loopback|deepseek] [--fixtures P1,P2] [--attempts 8] [--chain-attempts 4] [--thinking high] [--concurrency 1] [--label name] [--keep-sessions] [--max-requests N --max-minutes N --max-cost-usd N]`,
	);
}

const MEASURED = { provider: "deepseek", id: "deepseek-flash" };
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
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: [packageDir], cacheWarming: "off", defaultTools: [], compaction: { keepRecentTokens: 0 } }),
	);
	let commandOutput;
	const diagnostics = [];
	for (const level of ["log", "warn", "error"]) {
		const original = console[level].bind(console);
		console[level] = (...parts) => {
			const text = parts.map(String).join(" ");
			if (commandOutput) commandOutput.push(text);
			else if (!text.includes("context-memory preview")) original(...parts);
		};
	}
	const stock = await import(pathToFileURL(join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);

	// Loopback: the gold writer for scripted cuts and a fixed unknown answer for probes.
	const { gold } = readFixture(action.fixture);
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const part of request) raw += part;
		const payload = JSON.parse(raw);
		const serialized = JSON.stringify(payload.messages ?? []);
		const writer = serialized.includes("Return ONLY one JSON object matching this schema");
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
	let model;
	if (action.provider === "loopback") {
		model = { ...LOOPBACK, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
		runtime.registerProvider(model.provider, { api: model.api, apiKey: "bench-loopback-only", baseUrl: model.baseUrl, models: [model] });
	} else {
		// The Pi CLI installs its proxy-aware dispatcher at startup; an SDK caller has to do the same.
		const dispatcher = await import(pathToFileURL(join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "http-dispatcher.js")).href);
		dispatcher.configureHttpDispatcher();
		model = runtime.getModel(MEASURED.provider, MEASURED.id);
		if (!model) throw new Error(`${MEASURED.provider}/${MEASURED.id} is not in this Pi's catalog`);
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
	if (action.type === "compact") {
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
			repairKind: writer.repairKind ?? null,
			quotations: writer.quotations ?? null,
			quotationRepair: writer.quotationRepair ?? null,
			usage: writer.usage ?? null,
			pauseMs: after.lastCompaction?.pauseMs ?? null,
		};
		if (result.ok) {
			const note = readLines(action.sessionFile).findLast((entry) => entry.type === "compaction" && entry.details?.kind === "pi-context-memory")?.details.note;
			if (note) result.note = noteShape(note, contextBytes);
		}
	} else {
		session.setActiveToolsByName(action.condition === "history" ? ["context_history"] : []);
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
	const packageDir = resolve(argument("--package-dir"));
	const stockRoot = resolve(argument("--stock-root"));
	const outputDir = resolve(argument("--output-dir"));
	const mode = argument("--mode");
	const provider = argument("--provider", "loopback");
	const fixtures = argument("--fixtures", "P1,P2").split(",");
	const attempts = Number(argument("--attempts", "8"));
	const thinking = argument("--thinking", "high");
	const concurrency = Number(argument("--concurrency", "1"));
	const chainAttempts = Number(argument("--chain-attempts", "4"));
	const label = argument("--label", "run");
	if (!["writer", "probes", "smoke"].includes(mode)) throw new Error("--mode must be writer, probes or smoke");
	if (!["loopback", "deepseek"].includes(provider)) throw new Error("--provider must be loopback or deepseek");
	const limits =
		provider === "loopback"
			? { requests: Number.POSITIVE_INFINITY, minutes: Number.POSITIVE_INFINITY, costUsd: Number.POSITIVE_INFINITY }
			: { requests: Number(argument("--max-requests")), minutes: Number(argument("--max-minutes")), costUsd: Number(argument("--max-cost-usd")) };
	for (const [name, value] of Object.entries(limits))
		if (!(value > 0)) throw new Error(`--max-${name} must be positive for a provider run`);
	const build = JSON.parse(readFileSync(join(packageDir, "preview-build.json"), "utf8"));
	const hostVersion = JSON.parse(readFileSync(join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
	const runDir = join(outputDir, label);
	rmSync(runDir, { recursive: true, force: true });
	mkdirSync(runDir, { recursive: true });
	const started = Date.now();
	const used = { requests: 0, costUsd: 0, units: 0, unstarted: 0 };
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
		if (provider === "deepseek") {
			// The proxy injects the real key; Pi receives only a placeholder.
			value.DEEPSEEK_API_KEY = "proxy-injected";
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
		const encoded = Buffer.from(JSON.stringify({ ...action, cwd: join(runDir, "cwd", id) })).toString("base64url");
		const child = spawn(process.execPath, [script, "--worker", "--action", encoded, "--package-dir", packageDir, "--stock-root", stockRoot], { cwd: runDir, env: environment(agentDir), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (part) => (stdout += part));
		child.stderr.on("data", (part) => (stderr += part));
		const [code] = await once(child, "close");
		rmSync(agentDir, { recursive: true, force: true });
		const line = stdout.split("\n").find((item) => item.startsWith("BENCH_RESULT "));
		if (!line) return { crashed: true, exitCode: code, stderr: stderr.slice(-600) };
		return JSON.parse(line.slice("BENCH_RESULT ".length));
	}

	/** Measured requests and catalog cost, counted as each unit settles. */
	function spend(result, measured) {
		used.units++;
		if (!measured) return;
		used.requests += result.writerCalls ?? result.rounds ?? 0;
		used.costUsd += result.usage?.cost?.total ?? result.usage?.cost ?? 0;
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
	const report = { label, mode, provider, model: provider === "deepseek" ? `${MEASURED.provider}/${MEASURED.id}` : LOOPBACK.id, thinking, ...(mode === "probes" ? { chainAttempts } : {}), build: build.buildId ?? build.build ?? null, piVersion: hostVersion, fixtures, limits: shown };

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
				repairs: { quotation: list.filter((row) => row.repairKind === "quotation").length, size: list.filter((row) => row.repairKind === "size").length },
				repairedAndCommitted: list.filter((row) => row.repairKind && row.ok).length,
				repairOutcome: { requoted: sum((row) => row.quotationRepair?.requoted), unquoted: sum((row) => row.quotationRepair?.unquoted), dropped: sum((row) => row.quotationRepair?.dropped) },
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
				const results = await compactAt(fixture, k, provider, file);
				results.forEach((result, attempt) => {
					const row = { fixture: id, cut: k + 1, attempt: attempt + 1, ok: result.ok, code: result.code, writerCalls: result.writerCalls, repairKind: result.repairKind, quotations: result.quotations, quotationRepair: result.quotationRepair, pauseMs: result.pauseMs, usage: result.usage, crashed: result.crashed ?? false, note: noteRow(fixture, k, result.note) };
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
			compactions: { attempts: compactions.length, committed: compactions.filter((row) => row.ok).length, refusedByCode: compactions.filter((row) => !row.ok).reduce((codes, row) => ({ ...codes, [row.code ?? "UNKNOWN"]: (codes[row.code ?? "UNKNOWN"] ?? 0) + 1 }), {}), notes: noteSummary(compactions) },
			history: summarizePreview(scores.history),
			none: summarizePreview(scores.none),
			callsPerQuestion: Object.fromEntries(
				Object.entries(calls).map(([condition, value]) => [condition, { questions: value.questions, total: value.search + value.read + value.list + value.other, ...value }]),
			),
			missedEntry: Object.fromEntries(Object.entries(missed).map(([condition, value]) => [condition, { cited: rate(value.cited), uncited: rate(value.uncited) }])),
		};
	}

	report.used = { ...used, costUsd: Number(used.costUsd.toFixed(4)), minutes: Number(((Date.now() - started) / 60_000).toFixed(1)) };
	writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
	if (!args.includes("--keep-sessions")) rmSync(join(runDir, "copies"), { recursive: true, force: true });
	rmSync(join(runDir, "cwd"), { recursive: true, force: true });
	process.stdout.write(`${JSON.stringify(report.used)}\nSummary: ${join(runDir, "summary.json")}\n`);
	if (!existsSync(join(runDir, "summary.json"))) process.exit(1);
}

if (args.includes("--worker")) await worker();
else await parent();
