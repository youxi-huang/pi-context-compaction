import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FIXTURE_VERSION, LIMITS, fixtureRecipe, hashEntries, parseLatencyArguments, plannedCounts, runLatency, summarizeCalls, syntheticUsage } from "./context-memory-preview-latency.mjs";
import { OFFICIAL_PI_COHORT } from "./context-memory-preview-stock-install.mjs";

const baseArguments = ["--package-dir", "/tmp/package", "--stock-root", "/tmp/stock", "--output-dir", "/tmp/report", "--strategy", "synchronous", "--writer", "session"];
const knownUsage = { input: 12, output: 3, totalTokens: 15, cacheRead: 0, cacheWrite: null, reasoning: null, costMicros: null };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function scratch(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-latency-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value)}\n`); }

// Only dependency injection tests use this cohort stub. No SDK or provider is
// executed, and its artificial integrity never becomes compatibility evidence.
function cohortFixture(root) {
	const packages = {};
	const integrity = `sha512-${createHash("sha512").update("synthetic test cohort").digest("base64")}`;
	for (const name of OFFICIAL_PI_COHORT) {
		const key = `node_modules/${name}`;
		const directory = join(root, key);
		mkdirSync(join(directory, "dist/bundle"), { recursive: true });
		writeJson(join(directory, "package.json"), { name, version: "1.1.0" });
		writeFileSync(join(directory, "dist/index.js"), "// Not executed in report assembly tests.\n");
		writeFileSync(join(directory, "dist/bundle/cli.js"), "// Not executed.\n");
		packages[key] = { version: "1.1.0", integrity, resolved: `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-1.1.0.tgz` };
	}
	writeJson(join(root, "package.json"), { dependencies: Object.fromEntries(OFFICIAL_PI_COHORT.map((name) => [name, "1.1.0"])) });
	writeJson(join(root, "node_modules/.package-lock.json"), { lockfileVersion: 3, packages });
}

function packageFixture(root) {
	mkdirSync(join(root, "dist"), { recursive: true });
	writeJson(join(root, "package.json"), { name: "synthetic-preview-fixture", version: "0.0.0" });
	writeJson(join(root, "preview-build.json"), { build: "stock-preview+src.fixture", sourceHash: sha256("fixture") });
	writeFileSync(join(root, "dist/extension.js"), "// Not executed by report dependency tests.\n");
}

test("CLI permits only finite synthetic modes and explicit opt-in preparation policy", () => {
	const options = parseLatencyArguments(baseArguments);
	assert.equal(options.strategy, "synchronous");
	assert.equal(options.writer, "session");
	const background = baseArguments.map((value) => value === "synchronous" ? "background" : value);
	assert.throws(() => parseLatencyArguments(background), /complete declared opt-in policy/);
	assert.equal(parseLatencyArguments([...background, "--preparation-settings", "/tmp/policy.json"]).preparationSettings, "/tmp/policy.json");
	for (const args of [[], [...baseArguments, "--writer", "fixed"], [...baseArguments, "--provider", "real"], baseArguments.map((value) => value === "session" ? "tiered" : value), baseArguments.map((value) => value === "synchronous" ? "B-session-increment" : value), [...baseArguments, "--worker", "probe", "--work-dir", "/tmp/work", "--boundary", "3"]]) assert.throws(() => parseLatencyArguments(args));
});

test("S2 recipe freezes five turns, two boundaries, supersession and revocation", () => {
	const recipe = fixtureRecipe();
	assert.equal(recipe.version, FIXTURE_VERSION);
	assert.equal(recipe.rulings.length + recipe.traces.length + 1, LIMITS.construction);
	assert.deepEqual(recipe.boundaries.map((boundary) => [boundary.afterTurn, boundary.expectedPort, boundary.rotationAllowed]), [[3, 4317, true], [5, 4318, false]]);
	assert.equal(recipe.traces[0].split("\n").length, 6001);
	assert.equal(recipe.traces[1].split("\n").slice(1).join("\n"), recipe.traces[0].split("\n").slice(1).join("\n"));
	assert.match(recipe.rulings[1], /Permission to rotate the synthetic local credential is revoked/);
	assert.match(recipe.initial, /Initial inspection is already complete; do not repeat it/);
	assert.equal(sha256(JSON.stringify(recipe)), "4a1db2d1f9628fc51245d66ba0f2dde913d219085b955e09f334130ad49718a2");
});

test("source hash is the established ordered exact UTF-8 newline stream", () => {
	const entries = [{ id: "one", text: "line\n中文" }, { id: "two", value: 4318 }];
	assert.equal(hashEntries(entries), sha256(`${JSON.stringify(entries[0])}\n${JSON.stringify(entries[1])}\n`));
	assert.notEqual(hashEntries(entries), hashEntries([...entries].reverse()));
	assert.notEqual(hashEntries(entries), sha256(JSON.stringify(entries)));
});

test("unknown usage and cache/cost fields do not become free calls", () => {
	const returned = syntheticUsage({ messages: [{ role: "user", content: "synthetic" }] }, "ok");
	assert.equal(returned.cacheRead, 0);
	assert.equal(returned.cacheWrite, null);
	assert.equal(returned.reasoning, null);
	assert.equal(returned.costMicros, null);
	const totals = summarizeCalls([{ purpose: "preparation", outcome: "failed" }, { purpose: "preparation", outcome: "succeeded", usage: knownUsage }, { purpose: "probe", outcome: "succeeded", usage: { ...knownUsage, input: 20, totalTokens: 23, cacheWrite: 7, reasoning: 2, costMicros: 9 } }]);
	assert.equal(totals.calls, 3);
	assert.equal(totals.failed, 1);
	assert.equal(totals.unknownUsage, 1);
	assert.deepEqual(totals.usage, { input: 32, output: 6, totalTokens: 38, cacheRead: 0, cacheWrite: 7, reasoning: 2, costMicros: 9 });
	assert.deepEqual(totals.unknown, { input: 1, output: 1, totalTokens: 1, cacheRead: 1, cacheWrite: 2, reasoning: 2, costMicros: 2 });
	assert.deepEqual(totals.byPurpose, { preparation: 2, probe: 1 });
});

test("planned checkpoint/probe denominator retains failed, blocked and unstarted work", () => {
	const counts = plannedCounts([{ state: "completed" }, { state: "failed" }], [{ state: "completed" }, { state: "blocked" }, { state: "failed" }, { state: "unstarted" }]);
	assert.deepEqual(counts.checkpoints, { planned: 2, started: 2, completed: 1, failed: 1, blocked: 0, unstarted: 0 });
	assert.deepEqual(counts.probes, { planned: 6, started: 3, completed: 1, failed: 1, blocked: 1, unstarted: 3 });
});

test("report assembly isolates probe snapshots, preserves spent calls and cleans scratch after failure", async (t) => {
	const root = scratch(t);
	const packageDir = join(root, "source-package");
	const stockRoot = join(root, "official-stub");
	const outputDir = join(root, "output");
	packageFixture(packageDir);
	cohortFixture(stockRoot);
	const workers = [];
	let isolatedRoot;
	const report = await runLatency({ packageDir, stockRoot, outputDir, strategy: "synchronous", writer: "session" }, async (options, job, timeoutMs) => {
		workers.push(job);
		assert(timeoutMs > 0 && timeoutMs <= LIMITS.wallMs);
		assert.notEqual(options.packageDir, packageDir);
		assert(existsSync(join(outputDir, "manifest.json")), "Manifest must precede every dispatched worker");
		if (job.worker === "chain") {
			isolatedRoot = options.packageDir.replace(/\/package$/, "");
			mkdirSync(job.workDir, { recursive: true });
			writeFileSync(join(job.workDir, "checkpoint-1.jsonl"), "synthetic snapshot bytes\n");
			return { completed: false, error: "S2_SCRIPTED_FAILURE", exitCode: 1, calls: [{ callId: "preparation-1", purpose: "preparation", outcome: "failed" }, { callId: "sync-1", purpose: "foreground", outcome: "succeeded", usage: knownUsage }], boundaries: [{ boundary: 1, state: "completed", path: "sync" }, { boundary: 2, state: "failed" }] };
		}
		assert.equal(readFileSync(job.sessionFile, "utf8"), "synthetic snapshot bytes\n");
		writeFileSync(job.sessionFile, `mutated only by ${job.probe}\n`);
		return { completed: job.probe !== "action", exitCode: job.probe === "action" ? 1 : 0, probe: { boundary: 1, probe: job.probe, state: job.probe === "action" ? "failed" : "completed" }, calls: [{ callId: `probe-${job.probe}`, purpose: "probe", outcome: job.probe === "action" ? "failed" : "succeeded", ...(job.probe === "action" ? {} : { usage: knownUsage }) }], diagnostics: [] };
	});
	assert.equal(report.passed, false);
	assert.equal(report.semanticEvidence, false);
	assert.equal(workers.length, 4);
	assert.equal(new Set(workers.filter((job) => job.worker === "probe").map((job) => job.sessionFile)).size, 3);
	assert.equal(existsSync(isolatedRoot), false);
	assert.deepEqual(readdirSync(outputDir).sort(), ["manifest.json", "report.json"]);
	assert.equal(report.counts.checkpoints.failed, 1);
	assert.equal(report.counts.probes.failed, 1);
	assert.equal(report.counts.probes.unstarted, 3);
	assert.equal(report.callTotals.calls, 5);
	assert.equal(report.callTotals.unknownUsage, 2);
	assert.equal(report.callTotals.failed, 2);
	assert.equal(report.pathCounts.unselected, 1);
	assert.equal(report.probes.filter((probe) => probe.reason === "checkpoint-unavailable").length, 3);
	assert(!readFileSync(join(outputDir, "report.json"), "utf8").includes(root), "Summary must not expose local scratch paths");
});

test("background policies exceeding the frozen S2 envelope fail before any dispatch", async (t) => {
	const root = scratch(t);
	const packageDir = join(root, "package");
	const stockRoot = join(root, "official-stub");
	const outputDir = join(root, "output");
	const preparationSettings = join(root, "policy.json");
	packageFixture(packageDir);
	cohortFixture(stockRoot);
	const policy = { enabled: true, minSourceTokens: 2048, minIntervalMs: 0, deadlineMs: 120_000, maxCallsPerAttempt: 8, ledger: { maxAttemptsPerInterval: 1, maxCallsPerInterval: 8, maxCallsPerSession: 16, maxReservedTokensPerInterval: 1_200_000, maxReservedTokensPerSession: 2_400_000, maxReservedCostMicrosPerInterval: 1_000_000, maxReservedCostMicrosPerSession: 2_000_000, maxDetails: 64 } };
	let dispatched = 0;
	for (const invalid of [{ enabled: true }, { ...policy, deadlineMs: 120_001 }, { ...policy, ledger: { ...policy.ledger, maxCallsPerSession: 17 } }, { ...policy, ledger: { ...policy.ledger, maxReservedTokensPerSession: 1 } }, { ...policy, privatePath: "/tmp/private" }]) {
		writeJson(preparationSettings, invalid);
		await assert.rejects(() => runLatency({ packageDir, stockRoot, outputDir, preparationSettings, strategy: "background", writer: "fixed" }, async () => { dispatched++; }), /S2_PREPARATION_POLICY_INVALID/);
	}
	assert.equal(dispatched, 0);
	assert.equal(existsSync(join(outputDir, "manifest.json")), false);
});
