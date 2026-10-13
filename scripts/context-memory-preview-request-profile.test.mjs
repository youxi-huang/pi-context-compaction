import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { PROFILE_LIMITS, attributeProbes, collectorModuleSource, createProfileCollector, instrumentSource, instrumentWorker, instrumentationPlugin, parseProfileArguments, readProfileHttp, readProfileJournal, runRequestProfile, safeScenarioResult } from "./context-memory-preview-request-profile.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const extensionRoot = "packages/coding-agent/src/extensions/context-memory/";
function scratch(t) { const directory = mkdtempSync(join(tmpdir(), "pi-request-profile-test-")); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; }
function json(file, value) { writeFileSync(file, JSON.stringify(value)); }
function scenarioFixture() {
	return { case: "long-session-overhead", variant: "extension", providerRequests: 70, diagnostics: ["private text /tmp/private"], checks: [{ key: "bounded-growth", passed: false, detail: "private text /tmp/private" }], observations: [10, 20, "disabled-control"].map((milestone, group) => ({ step: "raw request timing samples", milestone, samplesMs: [1, 1, 1], monotonicIntervalsUs: [0, 1, 2].map((index) => ({ beginUs: 1000 + group * 10000 + index * 1000, endUs: 1900 + group * 10000 + index * 1000 })) })) };
}

test("the diagnostic envelope has no CLI expansion and remains separate from acceptance", () => {
	assert.deepEqual(parseProfileArguments(["--package-dir", "/tmp/candidate", "--stock-root", "/tmp/stock", "--output-dir", "/tmp/evidence"]), { packageDir: "/tmp/candidate", stockRoot: "/tmp/stock", outputDir: "/tmp/evidence" });
	assert.equal(PROFILE_LIMITS.checkpoints, 20);
	assert.equal(PROFILE_LIMITS.httpCalls, 70);
	assert.equal(PROFILE_LIMITS.wallMs, 180000);
	for (const extra of [["--wall-ms", "999999"], ["--perf-checkpoints", "60"], ["--package-dir", "/tmp/second"]]) assert.throws(() => parseProfileArguments(["--package-dir", "/tmp/candidate", "--stock-root", "/tmp/stock", "--output-dir", "/tmp/evidence", ...extra]), /Usage/);
});

test("nested timers partition actual intervals and persist failures without content", () => {
	let time = 100;
	const records = [];
	const collector = createProfileCollector({ clock: () => time, sink: (record) => records.push(record) });
	assert.equal(collector.hook("context", () => {
		collector.measure("prefix-total", () => {
			collector.measure("stringify", () => { time += 3; collector.count("serializedEntries"); });
			collector.measure("sha256-update", () => { time += 4; });
			time += 2;
		});
		time += 5;
		return 42;
	}), 42);
	const record = records[1];
	assert.equal(record.inclusiveUs, 14);
	assert.deepEqual(record.phases["prefix-total"], { calls: 1, inclusiveUs: 9, exclusiveUs: 2 });
	assert.equal(Object.values(record.phases).reduce((sum, phase) => sum + phase.exclusiveUs, record.unattributedUs), record.inclusiveUs);
	assert.deepEqual(record.counters, { serializedEntries: 1 });
	assert.equal(record.incompleteTimers, 0);
	const error = new Error("private session contents /tmp/private");
	assert.throws(() => collector.hook("context_with_system", () => collector.measure("disk-read", () => { time++; throw error; })), (cause) => cause === error);
	assert.equal(records.at(-1).state, "failed");
	assert.equal(records.at(-1).phases["disk-read"].calls, 1);
	assert(!JSON.stringify(records).includes("private"));
});

test("collector rejects foreign, reused and asynchronous ownership and bounds hooks", () => {
	const records = [];
	const first = createProfileCollector({ sink: (record) => records.push(record), limits: { ...PROFILE_LIMITS, hooks: 2 } });
	const second = createProfileCollector();
	first.hook("context", () => {
		const token = first.enter("stringify");
		second.hook("context", () => assert.throws(() => second.leave(token), /PROFILE_TIMER_OWNERSHIP/));
		first.leave(token);
		assert.throws(() => first.leave(token), /PROFILE_TIMER_OWNERSHIP/);
		assert.throws(() => first.hook("context", () => {}), /PROFILE_HOOK_REENTRY/);
		assert.throws(() => first.measure("user-content-as-label", () => {}), /PROFILE_PHASE_INVALID/);
		assert.throws(() => first.count("unknown-path"), /PROFILE_COUNTER_INVALID/);
	});
	assert.throws(() => first.hook("before_provider_request", () => Promise.resolve()), /PROFILE_ASYNC_HOOK/);
	assert.throws(() => first.hook("context", () => {}), /PROFILE_HOOK_CAP/);
	assert.equal(records.length, 4);
	assert.equal(records.at(-1).state, "failed");
});

test("byte-stage timers partition encoding, scanning and equality with distinct units", () => {
	let time = 0;
	const records = [];
	const collector = createProfileCollector({ clock: () => time, sink: (record) => records.push(record) });
	collector.hook("before_provider_request", () => {
		collector.measure("observer-array", () => {
			const encoded = collector.measure("canonical-encode", () => { time += 5; return Buffer.from('"中文🙂"', "utf8"); });
			collector.count("serializedCodeUnits", '"中文🙂"'.length);
			collector.count("canonicalEncodedEntries");
			collector.count("canonicalEncodedBytes", encoded.byteLength);
			time += 2;
		});
		collector.measure("readback", () => {
			collector.measure("line-scan", () => { time += 3; });
			collector.count("scannedLines");
			collector.count("scannedBytes", 13);
			collector.measure("byte-equality", () => { time += 4; });
			collector.count("byteEqualityCalls");
			collector.count("byteEqualityCandidateBytes", 12);
			time += 1;
		});
	});
	const record = records.at(-1);
	assert.deepEqual(record.phases["observer-array"], { calls: 1, inclusiveUs: 7, exclusiveUs: 2 });
	assert.deepEqual(record.phases["canonical-encode"], { calls: 1, inclusiveUs: 5, exclusiveUs: 5 });
	assert.equal(record.phases["line-scan"].exclusiveUs, 3);
	assert.equal(record.phases["byte-equality"].exclusiveUs, 4);
	assert.equal(record.counters.serializedCodeUnits, 6);
	assert.equal(record.counters.canonicalEncodedBytes, 12);
	assert.equal(record.counters.scannedBytes, 13);
	assert.equal(Object.values(record.phases).reduce((sum, phase) => sum + phase.exclusiveUs, record.unattributedUs), record.inclusiveUs);
});

test("all production anchors are exact and changed/duplicate anchors fail closed", () => {
	const files = ["identity.ts", "notes.ts", "preview/controller.ts", "preview/failure-store.ts", "preview/extension.ts"];
	for (const suffix of files) {
		const file = extensionRoot + suffix;
		const original = readFileSync(join(repository, file), "utf8");
		const transformed = instrumentSource(file, original);
		assert(transformed.anchors.length > 0);
		assert.equal(readFileSync(join(repository, file), "utf8"), original);
		assert.notEqual(transformed.sourceSha256, transformed.transformedSha256);
		assert.throws(() => instrumentSource(file, transformed.contents), /PROFILE_SOURCE_ALREADY_INSTRUMENTED/);
	}
	const file = extensionRoot + "identity.ts";
	const original = readFileSync(join(repository, file), "utf8");
	assert.throws(() => instrumentSource(file, original.replace("const serialized = JSON.stringify(entries[index]);", "const serialized = JSON.stringify(entries.at(index));")), /PROFILE_SOURCE_ANCHOR/);
	assert.throws(() => instrumentSource(file, original + original), /PROFILE_SOURCE_ANCHOR/);
	const byteFile = extensionRoot + "preview/failure-store.ts";
	const byteOriginal = readFileSync(join(repository, byteFile), "utf8");
	assert.throws(() => instrumentSource(byteFile, byteOriginal.replace('canonicalLines.push(Buffer.from(serialized, "utf8"));', 'canonicalLines.push(Buffer.from(serialized, "hex"));')), /PROFILE_SOURCE_ANCHOR:factory-observer-bytes/);
	assert.throws(() => instrumentSource(byteFile, byteOriginal.replace('data.compare(canonical, 0, canonical.length, start, end)', 'data.compare(canonical)')), /PROFILE_SOURCE_ANCHOR:byte-record-equality/);
	const worker = readFileSync(join(repository, "scripts/context-memory-preview-scenarios.mjs"), "utf8");
	assert.equal(instrumentWorker(worker).anchors.length, 2);
	assert.throws(() => instrumentWorker(worker.replace("const requests = [];", "const requests = Array();")), /PROFILE_SOURCE_ANCHOR/);
});

test("real transformed prefix code preserves hashes and counts serialization once", async (t) => {
	const directory = scratch(t);
	mkdirSync(join(directory, "dist"));
	const journal = join(directory, "hooks.jsonl");
	writeFileSync(journal, "");
	writeFileSync(join(directory, "profile-collector.mjs"), collectorModuleSource());
	const transforms = [];
	const compiled = await build({ absWorkingDir: repository, stdin: { contents: `export { hashEntryPrefixes } from ${JSON.stringify(join(repository, extensionRoot + "identity.ts"))}; export { hook } from "picompact:request-profile";`, resolveDir: repository }, bundle: true, write: false, format: "esm", platform: "node", packages: "external", outfile: join(directory, "dist/test.mjs"), plugins: [instrumentationPlugin(repository, transforms)], logLevel: "silent" });
	writeFileSync(join(directory, "dist/test.mjs"), compiled.outputFiles[0].contents);
	const previous = process.env.PICOMPACT_REQUEST_PROFILE_JOURNAL;
	process.env.PICOMPACT_REQUEST_PROFILE_JOURNAL = journal;
	t.after(() => { if (previous === undefined) delete process.env.PICOMPACT_REQUEST_PROFILE_JOURNAL; else process.env.PICOMPACT_REQUEST_PROFILE_JOURNAL = previous; });
	const runtime = await import(pathToFileURL(join(directory, "dist/test.mjs")).href);
	const entries = [{ id: "one", content: "α" }, { id: "two", content: "synthetic" }, { id: "three", content: "end" }];
	const hashes = runtime.hook("context", () => runtime.hashEntryPrefixes(entries, [1, 3]));
	assert.equal(hashes.get(3), createHash("sha256").update(entries.map((entry) => JSON.stringify(entry) + "\n").join("")).digest("hex"));
	const record = JSON.parse(readFileSync(journal, "utf8").trim().split("\n").at(-1));
	assert.equal(record.counters.serializedEntries, 3);
	assert.equal(record.counters.hashedEntries, 3);
	assert.equal(record.counters.hashBoundaries, 2);
	assert.equal(record.phases.stringify.calls, 3);
	assert.equal(record.phases["sha256-update"].calls, 3);
	assert.equal(transforms.length, 1);
	assert(!readFileSync(journal, "utf8").includes("synthetic"));
});

test("probe alignment uses only contained hooks and keeps the original nine samples", () => {
	const original = scenarioFixture();
	const result = safeScenarioResult(original);
	assert(!JSON.stringify(result).includes("private"));
	assert.deepEqual(result.observations, original.observations);
	const records = [{ id: 1, hook: "context", beginUs: 1050, state: "started" }, { id: 1, hook: "context", beginUs: 1050, endUs: 1300, state: "completed", phases: {}, counters: {} }, { id: 2, hook: "context_with_system", beginUs: 1850, endUs: 2050, state: "completed", phases: {}, counters: {} }, { id: 3, hook: "before_provider_request", beginUs: 2500, state: "started" }];
	const report = attributeProbes(result, records);
	assert.equal(report.probes.length, 9);
	assert.equal(report.probes[0].hookCounts.context, 1);
	assert.equal(report.probes[0].boundaryCrossingHooks, 1);
	assert.equal(report.probes[1].boundaryCrossingHooks, 1);
	assert.deepEqual(report.incompleteHookIds, [3]);
});

test("real transformed readback distinguishes canonical matching, plain proof and fallback", async (t) => {
	const directory = scratch(t);
	mkdirSync(join(directory, "dist"));
	const journal = join(directory, "hooks.jsonl");
	writeFileSync(journal, "");
	writeFileSync(join(directory, "profile-collector.mjs"), collectorModuleSource());
	const compiled = await build({ absWorkingDir: repository, stdin: { contents: `export { PreviewFailureStore, createPreviewBranchSnapshot } from ${JSON.stringify(join(repository, extensionRoot + "preview/failure-store.ts"))}; export { hook } from "picompact:request-profile";`, resolveDir: repository }, bundle: true, write: false, format: "esm", platform: "node", packages: "external", tsconfigRaw: { compilerOptions: {} }, outfile: join(directory, "dist/readback.mjs"), plugins: [instrumentationPlugin(repository, [])], logLevel: "silent" });
	writeFileSync(join(directory, "dist/readback.mjs"), compiled.outputFiles[0].contents);
	const previous = process.env.PICOMPACT_REQUEST_PROFILE_JOURNAL;
	process.env.PICOMPACT_REQUEST_PROFILE_JOURNAL = journal;
	t.after(() => { if (previous === undefined) delete process.env.PICOMPACT_REQUEST_PROFILE_JOURNAL; else process.env.PICOMPACT_REQUEST_PROFILE_JOURNAL = previous; });
	const runtime = await import(pathToFileURL(join(directory, "dist/readback.mjs")).href);
	const header = { type: "session", version: 3, id: "synthetic-session", timestamp: "2026-01-01T00:00:00.000Z" };
	const branch = [{ type: "message", id: "synthetic-user", parentId: null, timestamp: header.timestamp, message: { role: "user", content: "Synthetic original. 中文🙂 e\u0301 lone \ud800" } }, { type: "message", id: "synthetic-assistant", parentId: "synthetic-user", timestamp: header.timestamp, message: { role: "assistant", content: [], stopReason: "stop" } }];
	const file = join(directory, "session.jsonl");
	const session = { getSessionId: () => header.id, getSessionFile: () => file, getHeader: () => header, getSessionDir: () => directory, getBranch: () => [...branch], getEntries: () => [...branch], getLeafId: () => branch.at(-1).id };
	const perform = () => {
		const factory = runtime.createPreviewBranchSnapshot(branch);
		branch.forEach((entry, index) => factory.onSerializedEntry(index, JSON.stringify(entry)));
		new runtime.PreviewFailureStore(join(directory, "agent")).assertReady(session, factory.snapshot);
	};
	writeFileSync(file, [header, ...branch].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	runtime.hook("context", perform);
	let rows = readProfileJournal(journal).records;
	let record = rows.at(-1);
	assert.equal(record.phases["plain-data"].calls, 1);
	assert.equal(record.counters.observerEntries, 2);
	assert.equal(record.counters.proofMetadataRecords, 2);
	assert.equal(record.counters.canonicalEncodedEntries, 2);
	assert.equal(record.counters.canonicalEncodedBytes, branch.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0));
	assert(record.counters.canonicalEncodedBytes > branch.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0));
	assert.equal(record.phases["canonical-encode"].calls, 2);
	assert.equal(record.phases["observer-array"].calls, 2);
	assert.equal(record.counters.diskRecords, 2);
	assert.equal(record.counters.canonicalMatches, 2);
	assert.equal(record.counters.byteEqualityCalls, 2);
	assert.equal(record.counters.byteEqualityCandidateBytes, record.counters.canonicalEncodedBytes);
	assert.equal(record.phases["byte-equality"].calls, 2);
	assert.equal(record.phases["line-scan"].calls, 7, "precount, header lookup and entry scan remain visible");
	assert.equal(record.counters.precountLines, 3);
	assert.equal(record.counters.scannedLines, 3);
	assert.equal(record.counters.metadataRecords, 2);
	assert.equal(record.counters.diskBytes, Buffer.byteLength(readFileSync(file)));
	assert.equal(record.counters.scannedBytes, record.counters.diskBytes);
	assert.equal(record.counters.decodedBytes, Buffer.byteLength(JSON.stringify(header), "utf8"));
	assert.equal(record.phases["utf8-decode"].calls, 1, "only the header decodes on the exact-byte fast path");
	assert.equal(record.phases["entry-parse"], undefined);
	assert.equal(record.phases["fallback-hash"], undefined);
	writeFileSync(file, [header, ...branch].map((entry) => " " + JSON.stringify(entry)).join("\n") + "\n");
	runtime.hook("context_with_system", perform);
	record = readProfileJournal(journal).records.at(-1);
	assert.equal(record.counters.canonicalMisses, 2);
	assert.equal(record.phases["entry-parse"].calls, 2);
	assert.equal(record.phases["utf8-decode"].calls, 3);
	assert.equal(record.counters.decodedBytes, record.counters.diskBytes - 3);
	assert.equal(record.counters.fallbackBranchComparisons, 1);
	assert.equal(record.phases["fallback-hash"].calls, 2);
	writeFileSync(file, [header, { ...branch[0], message: { role: "user", content: "Changed synthetic original." } }, branch[1]].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	assert.throws(() => runtime.hook("before_provider_request", perform), /CONTEXT_SOURCE_CHANGED/);
	assert.equal(readProfileJournal(journal).records.at(-1).state, "failed");
	assert(!readFileSync(journal, "utf8").includes("Synthetic original"));
});

test("the full temporary transform compiles without bundling a host or changing source", async () => {
	const transforms = [];
	const result = await build({ absWorkingDir: repository, entryPoints: [extensionRoot + "preview/extension.ts"], bundle: true, write: false, metafile: true, format: "esm", platform: "node", packages: "external", tsconfigRaw: { compilerOptions: {} }, plugins: [instrumentationPlugin(repository, transforms)], logLevel: "silent" });
	assert.equal(transforms.length, 5);
	assert(Object.keys(result.metafile.inputs).every((file) => file.startsWith(extensionRoot)));
	const output = result.outputFiles[0].text;
	assert(output.includes('../profile-collector.mjs'));
	assert(!output.includes("globalThis.__cmProfile"));
});

test("onLoad consumes the verified snapshot even if live source changes before compilation", async (t) => {
	const directory = scratch(t);
	const file = extensionRoot + "identity.ts";
	const original = readFileSync(join(repository, file), "utf8");
	mkdirSync(join(directory, extensionRoot), { recursive: true });
	writeFileSync(join(directory, file), 'throw new Error("live source must not be bundled");');
	const transforms = [];
	const result = await build({ absWorkingDir: directory, entryPoints: [file], bundle: true, write: false, format: "esm", platform: "node", plugins: [instrumentationPlugin(directory, transforms, new Map([[file, original]]))], logLevel: "silent" });
	assert.equal(transforms.length, 1);
	assert.equal(transforms[0].sourceSha256, createHash("sha256").update(original).digest("hex"));
	assert(!result.outputFiles[0].text.includes("live source must not be bundled"));
	assert(result.outputFiles[0].text.includes("hashEntryPrefixes"));
});

test("truncated journals retain completed prefix evidence and reject arbitrary labels", (t) => {
	const directory = scratch(t);
	const file = join(directory, "hooks.jsonl");
	const started = { id: 1, hook: "context", beginUs: 100, state: "started" };
	const completed = { id: 1, hook: "context", beginUs: 100, endUs: 200, state: "completed", inclusiveUs: 100, unattributedUs: 50, incompleteTimers: 0, phases: { stringify: { calls: 1, inclusiveUs: 50, exclusiveUs: 50 } }, counters: { serializedEntries: 1 } };
	writeFileSync(file, JSON.stringify(started) + "\n" + JSON.stringify(completed) + '\n{"id":2');
	const truncated = readProfileJournal(file);
	assert.deepEqual(truncated.records, [started, completed]);
	assert(truncated.reason);
	writeFileSync(file, JSON.stringify(started) + "\n" + JSON.stringify({ ...completed, phases: { "/tmp/private": { calls: 1, inclusiveUs: 1, exclusiveUs: 1 } } }) + "\n");
	assert.equal(readProfileJournal(file).records.length, 1);
	assert.equal(readProfileJournal(file).reason, "PROFILE_JOURNAL_INVALID");
	writeFileSync(file, JSON.stringify(started) + "\n" + JSON.stringify({ ...completed, inclusiveUs: 101 }) + "\n");
	assert.equal(readProfileJournal(file).reason, "PROFILE_TIMING_INCONSISTENT");
	json(file, { ...started, endUs: "private path", inclusiveUs: "private contents" });
	assert.equal(readProfileJournal(file).reason, "PROFILE_JOURNAL_INVALID");
	assert.equal(readProfileJournal(file).records.length, 0);
	writeFileSync(file, "x".repeat(PROFILE_LIMITS.journalBytes + 1));
	assert.equal(readProfileJournal(file).reason, "PROFILE_JOURNAL_CAP");
});

test("HTTP evidence accepts only the frozen bounded numeric schema", (t) => {
	const directory = scratch(t);
	const file = join(directory, "http.json");
	for (const value of [{ calls: 70, ceiling: 70, exhausted: false }, { calls: 71, ceiling: 70, exhausted: true }]) { json(file, value); assert.deepEqual(readProfileHttp(file), { http: value }); }
	for (const value of [{ calls: 70, ceiling: 70, exhausted: false, note: "private text" }, { calls: 72, ceiling: 70, exhausted: true }, { calls: 1, ceiling: 71, exhausted: false }]) { json(file, value); assert.equal(readProfileHttp(file).reason, "PROFILE_HTTP_EVIDENCE_INVALID"); }
	writeFileSync(file, "x".repeat(513));
	assert.equal(readProfileHttp(file).reason, "PROFILE_HTTP_EVIDENCE_INVALID");
});

test("incomplete malformed call evidence still cleans scratch and releases ownership", async (t) => {
	const directory = scratch(t);
	const outputDir = join(directory, "evidence");
	let candidate;
	const report = await runRequestProfile({ packageDir: "unused", stockRoot: "unused", outputDir }, {
		inspectHost: () => ({ version: "1.1.0" }),
		buildPackage: async (_source, target) => { candidate = target; mkdirSync(target, { recursive: true }); return {}; },
		dispatch: async () => { json(join(outputDir, "cases/long-session-overhead--extension/result.json"), scenarioFixture()); writeFileSync(join(outputDir, "request-count.json"), "{"); return { exitCode: 0 }; },
	});
	assert.equal(report.state, "incomplete");
	assert.equal(report.probes.length, 9);
	assert.equal(report.http.calls, null);
	assert.equal(existsSync(candidate), false);
	assert.equal(existsSync(join(outputDir, "owner.json")), false);
});

test("finite dispatch retains partial evidence, removes scratch and refuses output reuse", async (t) => {
	const directory = scratch(t);
	const outputDir = join(directory, "evidence");
	let candidate;
	let dispatched = 0;
	const report = await runRequestProfile({ packageDir: join(directory, "package"), stockRoot: join(directory, "stock"), outputDir }, {
		inspectHost: () => ({ host: "synthetic unit-test stub", version: "1.1.0" }),
		buildPackage: async (_source, target) => { candidate = target; mkdirSync(target, { recursive: true }); return { baseline: { build: "unit-test", sourceHash: "1".repeat(64), bundleSha256: "2".repeat(64) }, diagnostic: { instrumentedBundleSha256: "3".repeat(64) } }; },
		dispatch: async (job) => {
			dispatched++;
			assert.equal(existsSync(join(outputDir, "owner.json")), true);
			assert.equal(PROFILE_LIMITS.httpCalls, 70);
			const caseDir = join(outputDir, "cases/long-session-overhead--extension");
			mkdirSync(join(caseDir, "sessions"));
			writeFileSync(join(caseDir, "sessions/synthetic.jsonl"), "regenerable synthetic state");
			json(join(caseDir, "result.json"), scenarioFixture());
			writeFileSync(job.journal, JSON.stringify({ id: 1, hook: "context", beginUs: 1050, state: "started" }) + "\n");
			json(join(outputDir, "request-count.json"), { calls: 2, ceiling: 70, exhausted: false });
			return { exitCode: null, signal: "SIGKILL", reason: "PROFILE_DEADLINE" };
		},
	});
	assert.equal(dispatched, 1);
	assert.equal(report.acceptance, false);
	assert.equal(report.state, "incomplete");
	assert.deepEqual(report.incompleteHookIds, [1]);
	assert.equal(report.probes.length, 9);
	assert.equal(existsSync(candidate), false);
	assert.equal(existsSync(join(outputDir, "owner.json")), false);
	assert.deepEqual(readdirSync(join(outputDir, "cases/long-session-overhead--extension")), ["result.json"]);
	for (const file of ["manifest.json", "report.json", "hooks.jsonl", "cases/long-session-overhead--extension/result.json"]) assert(!readFileSync(join(outputDir, file), "utf8").includes(directory));
	await assert.rejects(() => runRequestProfile({ packageDir: "unused", stockRoot: "unused", outputDir }), /PROFILE_OUTPUT_NOT_EMPTY/);
});

test("pre-dispatch failure leaves a content-free terminal manifest and releases ownership", async (t) => {
	const directory = scratch(t);
	const outputDir = join(directory, "evidence");
	let dispatched = false;
	const report = await runRequestProfile({ packageDir: "unused", stockRoot: "unused", outputDir }, { inspectHost: () => { throw new Error("private path /tmp/private"); }, dispatch: () => { dispatched = true; } });
	assert.equal(dispatched, false);
	assert.equal(report.state, "incomplete");
	assert.equal(report.worker.reason, "PROFILE_DIAGNOSTIC_FAILED");
	assert.equal(existsSync(join(outputDir, "owner.json")), false);
	assert(!readFileSync(join(outputDir, "manifest.json"), "utf8").includes("private"));
});
