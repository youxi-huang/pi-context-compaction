import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUARD_CASES, GUARD_LIMITS, buildGuardBundle, guardEnvironment, outsideRepository, parseGuardArguments, runGuardHarness, safeGuardResult } from "./context-memory-authority-guards.mjs";

// CI runs this file before installing official Pi. All fixtures below are
// self-contained; actual stock SDK assertions live in the explicit CLI only.
const repository = fileURLToPath(new URL("../", import.meta.url));
const guards = "packages/coding-agent/src/extensions/context-memory/preview/authority-bridge-guards.ts";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function scratch(t) { const directory = mkdtempSync(join(tmpdir(), "pi-authority-guards-unit-")); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; }
function fixtureRoot(directory) { const root = join(directory, "source"); mkdirSync(join(root, "packages/coding-agent/src/extensions/context-memory/preview"), { recursive: true }); writeFileSync(join(root, guards), readFileSync(join(repository, guards))); return root; }
function result(caseName = "legacy") {
	return { case: caseName, readerMode: "deterministic-stub", readerExposure: "all-events", ownershipFixture: "synthetic-policy", ownershipState: "not-read", classification: "legacy-control", stage: "complete", state: "passed", code: "GUARDS_OK", provider: { adapterEntries: 1, fetchDispatches: 0, abortedFetches: 0 }, events: [], checks: { loaded: true }, mutations: 0 };
}
function fakeDependencies(t, execute) {
	const work = [];
	t.after(() => { for (const path of work) assert(!existsSync(path), "temporary worker tree survived cleanup"); });
	return { inspect: () => ({ version: "1.1.0", host: "unit fixture, not official evidence" }), compile: async (directory) => { work.push(directory); const bundleFile = join(directory, "guards.mjs"); writeFileSync(bundleFile, "export {};"); return { bundleFile, readerMode: "deterministic-stub", bundleSha256: hash("export {};"), sourceGraphSha256: hash("unit"), sources: [] }; }, execute };
}

test("arguments, output ownership and environment have fixed bounds and no inherited credentials", (t) => {
	const directory = scratch(t);
	assert.deepEqual(parseGuardArguments(["--stock-root", "/tmp/unit-stock", "--output-dir", directory]), { stockRoot: "/tmp/unit-stock", outputDir: directory, reader: "deterministic-stub" });
	for (const extra of [["--reader", "unknown"], ["--workers", "999"], ["--stock-root", "/tmp/duplicate"]]) assert.throws(() => parseGuardArguments(["--stock-root", "/tmp/unit-stock", "--output-dir", directory, ...extra]), /GUARDS_REPORT_INVALID/);
	assert.throws(() => outsideRepository(repository), /GUARDS_REPORT_INVALID/);
	assert.throws(() => outsideRepository(join(repository, "docs/private-report")), /GUARDS_REPORT_INVALID/);
	assert.equal(GUARD_CASES.length, GUARD_LIMITS.workers);
	assert.equal(new Set(GUARD_CASES).size, GUARD_CASES.length);
	assert.equal(GUARD_LIMITS.providerCalls, 8);
	assert.equal(GUARD_LIMITS.wallMs, 180000);
	const env = guardEnvironment(directory);
	assert.equal(env.PI_OFFLINE, "1"); assert.equal(env.EVAL_MODEL_CALL_BUDGET, "0");
	assert(!Object.hasOwn(env, "HOME")); assert(!Object.hasOwn(env, "OPENAI_API_KEY")); assert(!Object.hasOwn(env, "NODE_OPTIONS"));
});

test("reports reject arbitrary content, paths, labels, missing fields and oversized counts", () => {
	const valid = result();
	assert.deepEqual(safeGuardResult(valid), valid);
	for (const changed of [
		{ ...valid, private: "private text /tmp/private" },
		{ ...valid, code: "private text /tmp/private" },
		{ ...valid, checks: { "private text": true } },
		{ ...valid, checks: { loaded: false } },
		{ ...valid, provider: { ...valid.provider, fetchDispatches: 3 } },
		{ ...valid, events: [{ event: "private text", denied: true, active: false, aborted: false, handled: true, cancelled: false, stopped: false }] },
		{ ...valid, events: Array.from({ length: GUARD_LIMITS.events + 1 }, () => ({})) },
	]) assert.throws(() => safeGuardResult(changed), /GUARDS_REPORT_INVALID/);
});

test("source-bound build loads actual guard code without an official installation", async (t) => {
	const directory = scratch(t), root = fixtureRoot(directory);
	const provenance = await buildGuardBundle(directory, { root });
	assert.equal(provenance.sources.length, 1);
	assert.equal(provenance.sources[0].file, guards);
	assert.equal(provenance.sources[0].sha256, hash(readFileSync(join(root, guards))));
	assert.equal(provenance.bundleSha256, hash(readFileSync(provenance.bundleFile)));
	const module = await import(pathToFileURL(provenance.bundleFile).href);
	const handlers = new Map();
	let reject = true, aborts = 0, notifications = 0;
	const ctx = { sessionManager: {}, signal: { aborted: false }, abort() { aborts++; this.signal.aborted = true; }, ui: { notify() { notifications++; throw new Error("synthetic private notification failure"); } } };
	const reader = { assertLegacy(_session, action) { assert(["dispatch", "compact", "recover", "navigate", "fork"].includes(action)); if (reject) throw new Error("synthetic ownership"); } };
	module.installAuthorityBridgeGuards({ on(event, handler) { handlers.set(event, handler); } }, reader);
	assert.equal(handlers.size, 8);
	assert.deepEqual(await handlers.get("input")({}, ctx), { action: "handled" });
	assert.deepEqual(await handlers.get("cache_warming_decision")({}, ctx), { action: "stop" });
	for (const event of ["context", "context_with_system", "before_provider_request"]) { ctx.signal.aborted = false; await handlers.get(event)({ messages: [{ role: "system", content: "synthetic system" }] }, ctx); assert(ctx.signal.aborted); }
	assert.equal(aborts, 3);
	for (const event of ["session_before_compact", "session_before_tree", "session_before_fork"]) assert.deepEqual(await handlers.get(event)({}, ctx), { cancel: true });
	let mutation = 0;
	assert.throws(() => { module.assertLegacyAuthorityOperation(reader, ctx, "recover"); mutation++; });
	assert.equal(mutation, 0); assert.equal(notifications, 8);
	reject = false;
	for (const handler of handlers.values()) assert.equal(await handler({}, ctx), undefined);
	module.assertLegacyAuthorityOperation(reader, ctx, "recover"); mutation++;
	assert.equal(mutation, 1);
});

test("source graph rejects unknown local runtime loaders and unavailable bridge instead of substituting a stub", async (t) => {
	const directory = scratch(t), root = fixtureRoot(directory);
	await assert.rejects(buildGuardBundle(directory, { root, reader: "bridge" }), /GUARDS_BRIDGE_UNAVAILABLE/);
	const source = readFileSync(join(root, guards), "utf8");
	writeFileSync(join(root, "packages/coding-agent/src/extensions/context-memory/preview/extra.js"), "export {};");
	writeFileSync(join(root, guards), `import "./extra.js";\n${source}`);
	await assert.rejects(buildGuardBundle(directory, { root }), /GUARDS_SOURCE_GRAPH/);
});

test("parent preserves a finite sanitized failed prefix and cleans temporary session trees", async (t) => {
	const directory = scratch(t);
	let executions = 0;
	const report = await runGuardHarness({ stockRoot: "/tmp/unit-stock", outputDir: join(directory, "report"), reader: "deterministic-stub" }, fakeDependencies(t, (_program, args, options) => {
		executions++;
		assert(options.timeout <= GUARD_LIMITS.workerMs);
		assert.equal(options.env.PI_OFFLINE, "1");
		assert.equal(args[10], String(GUARD_LIMITS.providerCalls));
		const evidence = args[7], caseName = args[8];
		writeFileSync(join(evidence, "result.json"), JSON.stringify(executions === 1 ? result(caseName) : { ...result(caseName), private: "private content /tmp/private" }));
		return { status: executions === 1 ? 0 : 1, stdout: "private output /tmp/private", stderr: "private failure /tmp/private" };
	}));
	assert.equal(executions, 2); assert.equal(report.state, "failed"); assert.equal(report.cases.length, 2);
	assert.equal(report.cases[1].code, "GUARDS_REPORT_INVALID");
	const text = readFileSync(join(directory, "report/report.json"), "utf8");
	assert(!text.includes("private")); assert(!text.includes("/tmp/unit-stock"));
	assert.equal(readFileSync(join(directory, "report/report.sha256"), "utf8").trim(), hash(text));
	assert.throws(() => parseGuardArguments(["--stock-root", "/tmp/unit-stock", "--output-dir", repository]));
});

test("total dispatch cap stops additional workers and retains the failing count", async (t) => {
	const directory = scratch(t);
	let executions = 0;
	const report = await runGuardHarness({ stockRoot: "/tmp/unit-stock", outputDir: join(directory, "report"), reader: "deterministic-stub" }, fakeDependencies(t, (_program, args) => {
		executions++;
		assert.equal(Number(args[10]), GUARD_LIMITS.providerCalls - (executions - 1));
		writeFileSync(join(args[7], "result.json"), JSON.stringify({ ...result(args[8]), provider: { adapterEntries: 1, fetchDispatches: 1, abortedFetches: 0 } }));
		return { status: 0, stdout: "", stderr: "" };
	}));
	assert.equal(report.code, "GUARDS_PROVIDER_LIMIT"); assert.equal(executions, GUARD_LIMITS.providerCalls + 1);
	assert.equal(report.providerDispatches, GUARD_LIMITS.providerCalls + 1);
});

test("invalid worker evidence cannot overwrite a symlink target while sanitizing", async (t) => {
	const directory = scratch(t), target = join(directory, "unrelated");
	writeFileSync(target, "synthetic unrelated bytes");
	const report = await runGuardHarness({ stockRoot: "/tmp/unit-stock", outputDir: join(directory, "report"), reader: "deterministic-stub" }, fakeDependencies(t, (_program, args) => {
		const file = join(args[7], "result.json"); rmSync(file); symlinkSync(target, file);
		return { status: 1, stdout: "", stderr: "" };
	}));
	assert.equal(report.cases[0].code, "GUARDS_REPORT_INVALID");
	assert.equal(readFileSync(target, "utf8"), "synthetic unrelated bytes");
	assert.equal(JSON.parse(readFileSync(join(directory, "report/legacy/result.json"))).code, "GUARDS_REPORT_INVALID");
});

test("an abort retains the bounded completed prefix and releases signal handlers", async (t) => {
	const directory = scratch(t);
	const before = process.listenerCount("SIGINT");
	let executions = 0;
	const report = await runGuardHarness({ stockRoot: "/tmp/unit-stock", outputDir: join(directory, "report"), reader: "deterministic-stub" }, fakeDependencies(t, (_program, args) => {
		executions++;
		writeFileSync(join(args[7], "result.json"), JSON.stringify(result(args[8])));
		process.emit("SIGINT");
		return { status: 0, stdout: "", stderr: "" };
	}));
	assert.equal(report.code, "GUARDS_ABORTED"); assert.equal(report.cases.length, 1); assert.equal(executions, 1);
	assert.equal(process.listenerCount("SIGINT"), before);
});

test("an actual OS signal is delivered after one bounded worker", async (t) => {
	const directory = scratch(t), output = join(directory, "report");
	const code = `import { spawnSync } from 'node:child_process'; import { mkdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { runGuardHarness } from ${JSON.stringify(pathToFileURL(join(repository, "scripts/context-memory-authority-guards.mjs")).href)};
const report = await runGuardHarness({stockRoot:'/tmp/unit-stock',outputDir:${JSON.stringify(output)},reader:'deterministic-stub'}, {inspect:()=>({version:'1.1.0',host:'unit fixture'}),compile:async(directory)=>({bundleFile:join(directory,'unit.mjs'),sources:[]}),execute:(_program,args)=>{const value=${JSON.stringify(result())}; value.case=args[8]; writeFileSync(join(args[7],'result.json'),JSON.stringify(value)); process.stdout.write('worker-start\\n'); spawnSync(process.execPath,['-e','setTimeout(()=>{},600)'],{timeout:2000}); return {status:0,stdout:'',stderr:''}; }}); process.exitCode=report.code==='GUARDS_ABORTED'?0:1;`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: directory, env: guardEnvironment(directory), stdio: ["ignore", "pipe", "pipe"] });
	t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
	const exited = once(child, "exit");
	child.stdout.once("data", () => child.kill("SIGTERM"));
	const [status] = await exited;
	assert.equal(status, 0);
	const report = JSON.parse(readFileSync(join(output, "report.json")));
	assert.equal(report.code, "GUARDS_ABORTED"); assert.equal(report.cases.length, 1);
});

test("whole deadline prevents workers and still writes evidence", async (t) => {
	const directory = scratch(t);
	let ticks = 0, executions = 0;
	const dependencies = fakeDependencies(t, () => { executions++; throw new Error("must not run"); });
	dependencies.clock = () => ticks++ === 0 ? 0 : GUARD_LIMITS.wallMs + 1;
	const report = await runGuardHarness({ stockRoot: "/tmp/unit-stock", outputDir: join(directory, "report"), reader: "deterministic-stub" }, dependencies);
	assert.equal(executions, 0); assert.equal(report.code, "GUARDS_TOTAL_DEADLINE"); assert.equal(report.cases.length, 0);
	assert(existsSync(join(directory, "report/report.json")));
});
