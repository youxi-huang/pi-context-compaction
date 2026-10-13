import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inspectOfficialPi } from "./context-memory-preview-stock-install.mjs";

// Diagnostic only: inject timers into a temporary package, never the installed
// runtime. The unchanged S1 recipe and its nine timing samples remain separate
// from acceptance. No CPU or provider experiment runs when this module imports.
export const PROFILE_VERSION = "s1-request-components.2";
export const PROFILE_LIMITS = Object.freeze({ checkpoints: 20, httpCalls: 70, wallMs: 180_000, hooks: 210, journalBytes: 3 * 1024 * 1024, recordBytes: 16 * 1024, workerOutputBytes: 1024 * 1024 });
export const PROFILE_PHASES = Object.freeze(["memory-branch", "snapshot-proof", "checkpoint-validation", "prefix-total", "stringify", "sha256-update", "sha256-boundary", "observer-array", "canonical-encode", "record-precount", "line-scan", "canonical-select", "byte-equality", "store-evaluate", "readback", "disk-read", "utf8-decode", "header-parse", "plain-data", "canonical-metadata-proof", "entry-parse", "metadata", "snapshot-match", "disk-branch", "branch-compare", "fallback-hash"]);
export const PROFILE_COUNTERS = Object.freeze(["serializedEntries", "serializedCodeUnits", "hashedEntries", "hashBoundaries", "observerEntries", "canonicalEncodedEntries", "canonicalEncodedBytes", "precountLines", "scannedLines", "scannedBytes", "decodedBytes", "byteEqualityCalls", "byteEqualityCandidateBytes", "diskBytes", "diskRecords", "canonicalMatches", "canonicalMisses", "plainDataObjects", "plainDataProperties", "proofMetadataRecords", "metadataRecords", "fallbackBranchComparisons"]);
const repository = fileURLToPath(new URL("../", import.meta.url));
const extensionRoot = "packages/coding-agent/src/extensions/context-memory/";
const profileImport = "picompact:request-profile";
const importLine = `import { measure as __cmProfileMeasure, count as __cmProfileCount, hook as __cmProfileHook, enter as __cmProfileEnter, leave as __cmProfileLeave } from ${JSON.stringify(profileImport)};\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const usage = "Usage: node scripts/context-memory-preview-request-profile.mjs --package-dir <unchanged candidate> --stock-root <official Pi 1.1.0> --output-dir <new evidence directory>";

export function parseProfileArguments(args) {
	const keys = { "--package-dir": "packageDir", "--stock-root": "stockRoot", "--output-dir": "outputDir" };
	const result = {};
	for (let index = 0; index < args.length; index += 2) {
		const key = keys[args[index]];
		if (!key || result[key] || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(usage);
		result[key] = resolve(args[index + 1]);
	}
	if (!Object.values(keys).every((key) => result[key])) throw new Error(usage);
	return result;
}

// Tokens are owned by one collector and one synchronous hook. Inclusive and
// exclusive times are distinct; exclusive partitions subtract child intervals
// once, rather than adding nested totals. Never accept arbitrary output labels.
export function createProfileCollector({ clock = () => Number(process.hrtime.bigint() / 1000n), sink = () => {}, limits = PROFILE_LIMITS } = {}) {
	let active;
	let sequence = 0;
	const owner = {};
	const allowedPhases = new Set(PROFILE_PHASES);
	const allowedCounters = new Set(PROFILE_COUNTERS);
	function enter(name) {
		if (!active) return undefined;
		if (!allowedPhases.has(name)) throw new Error("PROFILE_PHASE_INVALID");
		const token = { owner, root: active, name, beginUs: clock(), childrenUs: 0 };
		active.stack.push(token);
		return token;
	}
	function leave(token) {
		if (!token) return;
		if (token.owner !== owner || token.root !== active || active.stack.at(-1) !== token) throw new Error("PROFILE_TIMER_OWNERSHIP");
		const endUs = clock();
		assert(endUs >= token.beginUs, "PROFILE_CLOCK_REGRESSED");
		active.stack.pop();
		const elapsed = endUs - token.beginUs;
		const parent = active.stack.at(-1);
		if (parent) parent.childrenUs += elapsed;
		else active.childrenUs += elapsed;
		const row = active.phases[token.name] ??= { calls: 0, inclusiveUs: 0, exclusiveUs: 0 };
		row.calls++;
		row.inclusiveUs += elapsed;
		row.exclusiveUs += elapsed - token.childrenUs;
	}
	function measure(name, action) {
		const token = enter(name);
		try { return action(); }
		finally { leave(token); }
	}
	function count(name, value = 1) {
		if (!active) return;
		if (!allowedCounters.has(name) || !Number.isSafeInteger(value) || value < 0) throw new Error("PROFILE_COUNTER_INVALID");
		const next = (active.counters[name] ?? 0) + value;
		if (!Number.isSafeInteger(next)) throw new Error("PROFILE_COUNTER_OVERFLOW");
		active.counters[name] = next;
	}
	function hook(name, action) {
		if (!["context", "context_with_system", "before_provider_request"].includes(name)) throw new Error("PROFILE_HOOK_INVALID");
		if (active) throw new Error("PROFILE_HOOK_REENTRY");
		if (++sequence > limits.hooks) throw new Error("PROFILE_HOOK_CAP");
		const root = { id: sequence, hook: name, beginUs: clock(), childrenUs: 0, phases: {}, counters: {}, stack: [] };
		sink({ id: root.id, hook: name, beginUs: root.beginUs, state: "started" });
		active = root;
		let outcome = "completed";
		try {
			const value = action();
			if (value && typeof value.then === "function") throw new Error("PROFILE_ASYNC_HOOK");
			return value;
		} catch (error) {
			outcome = "failed";
			throw error;
		} finally {
			const endUs = clock();
			active = undefined;
			sink({ id: root.id, hook: name, beginUs: root.beginUs, endUs, state: outcome, incompleteTimers: root.stack.length,
				inclusiveUs: endUs - root.beginUs, unattributedUs: endUs - root.beginUs - root.childrenUs, phases: root.phases, counters: root.counters });
		}
	}
	return { enter, leave, measure, count, hook };
}

export function collectorModuleSource() {
	return `import assert from "node:assert/strict";\nimport { closeSync, fstatSync, openSync, writeSync } from "node:fs";\nconst PROFILE_LIMITS = ${JSON.stringify(PROFILE_LIMITS)};\nconst PROFILE_PHASES = ${JSON.stringify(PROFILE_PHASES)};\nconst PROFILE_COUNTERS = ${JSON.stringify(PROFILE_COUNTERS)};\n${createProfileCollector.toString()}\n` +
		`const fd = openSync(process.env.PICOMPACT_REQUEST_PROFILE_JOURNAL, "a");\nlet rows = 0;\nconst collector = createProfileCollector({ sink(record) {\nconst bytes = Buffer.from(JSON.stringify(record) + "\\n");\nif (++rows > PROFILE_LIMITS.hooks * 2 || bytes.length > PROFILE_LIMITS.recordBytes || fstatSync(fd).size + bytes.length > PROFILE_LIMITS.journalBytes) throw new Error("PROFILE_JOURNAL_CAP");\nlet offset = 0; while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset); if (!written) throw new Error("PROFILE_JOURNAL_IO"); offset += written; }\n} });\nprocess.once("exit", () => closeSync(fd));\nexport const { enter, leave, measure, count, hook } = collector;\n`;
}

function replaceAnchor(source, before, after, label, anchors) {
	const count = source.split(before).length - 1;
	if (count !== 1) throw new Error(`PROFILE_SOURCE_ANCHOR:${label}:${count}`);
	anchors.push({ label, sha256: sha256(before) });
	return source.replace(before, after);
}

export function instrumentSource(file, original) {
	const anchors = [];
	if (original.includes("__cmProfile")) throw new Error("PROFILE_SOURCE_ALREADY_INSTRUMENTED");
	let source = original;
	const patch = (before, after, label) => { source = replaceAnchor(source, before, after, label, anchors); };
	if (file === `${extensionRoot}identity.ts`) {
		patch('if (requested.has(0)) result.set(0, hash.copy().digest("hex"));', 'if (requested.has(0)) { __cmProfileCount("hashBoundaries"); result.set(0, __cmProfileMeasure("sha256-boundary", () => hash.copy().digest("hex"))); }', "empty-prefix-boundary");
		patch('const serialized = JSON.stringify(entries[index]);\n\t\thash.update(serialized).update("\\n");\n\t\tonSerializedEntry?.(index, serialized);\n\t\tif (requested.has(index + 1)) result.set(index + 1, hash.copy().digest("hex"));',
			'const serialized = __cmProfileMeasure("stringify", () => JSON.stringify(entries[index]));\n\t\t__cmProfileCount("serializedEntries");\n\t\t__cmProfileCount("serializedCodeUnits", serialized.length);\n\t\t__cmProfileMeasure("sha256-update", () => hash.update(serialized).update("\\n"));\n\t\t__cmProfileCount("hashedEntries");\n\t\tonSerializedEntry?.(index, serialized);\n\t\tif (requested.has(index + 1)) { __cmProfileCount("hashBoundaries"); result.set(index + 1, __cmProfileMeasure("sha256-boundary", () => hash.copy().digest("hex"))); }', "prefix-loop");
	} else if (file === `${extensionRoot}notes.ts`) {
		patch("const prefixHashes = hashEntryPrefixes(branch, prefixLengths, onSerializedEntry);", "const prefixHashes = __cmProfileMeasure(\"prefix-total\", () => hashEntryPrefixes(branch, prefixLengths, onSerializedEntry));", "prefix-call");
		patch("for (const [index, entry] of branch.entries()) onSerializedEntry(index, JSON.stringify(entry));", 'for (const [index, entry] of branch.entries()) { const serialized = __cmProfileMeasure("stringify", () => JSON.stringify(entry)); __cmProfileCount("serializedEntries"); __cmProfileCount("serializedCodeUnits", serialized.length); onSerializedEntry(index, serialized); }', "uncompacted-serialization");
	} else if (file === `${extensionRoot}preview/controller.ts`) {
		patch('\t\tconst branch = ctx.sessionManager.getBranch();\n\t\tconst factory = createPreviewBranchSnapshot(branch);\n\t\tconst checkpoint = assertPreviewSession(ctx.sessionManager, this.hostVersion, branch, factory?.onSerializedEntry);',
			'\t\tconst branch = __cmProfileMeasure("memory-branch", () => ctx.sessionManager.getBranch());\n\t\tconst factory = __cmProfileMeasure("snapshot-proof", () => createPreviewBranchSnapshot(branch));\n\t\tconst checkpoint = __cmProfileMeasure("checkpoint-validation", () => assertPreviewSession(ctx.sessionManager, this.hostVersion, branch, factory?.onSerializedEntry));', "readiness-validation");
		patch("this.store.assertReady(ctx.sessionManager, factory?.snapshot);", '__cmProfileMeasure("store-evaluate", () => this.store.assertReady(ctx.sessionManager, factory?.snapshot));', "readiness-store");
	} else if (file === `${extensionRoot}preview/extension.ts`) {
		patch('pi.on("context", (event, ctx) => ({ messages: controller.context(event.messages, ctx) }));', 'pi.on("context", (event, ctx) => __cmProfileHook("context", () => ({ messages: controller.context(event.messages, ctx) })));', "hook-context");
		patch('pi.on("context_with_system", (event, ctx) => ({ messages: controller.context(event.messages, ctx) }));', 'pi.on("context_with_system", (event, ctx) => __cmProfileHook("context_with_system", () => ({ messages: controller.context(event.messages, ctx) })));', "hook-system");
		patch('pi.on("before_provider_request", (event, ctx) => controller.beforeRequest(event.payload, ctx));', 'pi.on("before_provider_request", (event, ctx) => __cmProfileHook("before_provider_request", () => controller.beforeRequest(event.payload, ctx)));', "hook-payload");
	} else if (file === `${extensionRoot}preview/failure-store.ts`) {
		patch("if (!plainData(branch, new WeakSet<object>()) || !branch.every(canonicalMetadata)) return undefined;", 'if (!__cmProfileMeasure("plain-data", () => plainData(branch, new WeakSet<object>())) || !__cmProfileMeasure("canonical-metadata-proof", () => branch.every(canonicalMetadata))) return undefined;', "whole-branch-plain-proof");
		patch('function canonicalMetadata(entry: SessionEntry): boolean {', 'function canonicalMetadata(entry: SessionEntry): boolean { __cmProfileCount("proofMetadataRecords");', "canonical-metadata-proof-count");
		patch('canonicalLines.push(Buffer.from(serialized, "utf8"));', 'const canonicalBytes = __cmProfileMeasure("canonical-encode", () => Buffer.from(serialized, "utf8"));\n\t\t\t__cmProfileCount("canonicalEncodedEntries");\n\t\t\t__cmProfileCount("canonicalEncodedBytes", canonicalBytes.byteLength);\n\t\t\t__cmProfileCount("observerEntries");\n\t\t\t__cmProfileMeasure("observer-array", () => canonicalLines.push(canonicalBytes));', "factory-observer-bytes");
		patch('\t\tseen.add(current);\n\t\tchecked.push(current);', '\t\t__cmProfileCount("plainDataObjects");\n\t\tseen.add(current);\n\t\tchecked.push(current);', "plain-object");
		patch("for (const key of Reflect.ownKeys(current)) {", 'for (const key of Reflect.ownKeys(current)) { __cmProfileCount("plainDataProperties");', "plain-properties");
		patch('const data = readBoundedFile(identity.file, MAX_SESSION_BYTES, "CONTEXT_PREVIEW_SESSION_INVALID");', 'const data = __cmProfileMeasure("disk-read", () => readBoundedFile(identity.file, MAX_SESSION_BYTES, "CONTEXT_PREVIEW_SESSION_INVALID"));\n\t\t__cmProfileCount("diskBytes", data.byteLength);', "disk-read-bytes");
		patch('for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, end + 1)) {\n\t\t\tif (++lines > MAX_SESSION_ENTRIES + 1) throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_INVALID");\n\t\t}', '__cmProfileMeasure("record-precount", () => {\n\t\tfor (let end = __cmProfileMeasure("line-scan", () => data.indexOf(10)); end !== -1; end = __cmProfileMeasure("line-scan", () => data.indexOf(10, end + 1))) {\n\t\t\t__cmProfileCount("precountLines");\n\t\t\tif (++lines > MAX_SESSION_ENTRIES + 1) throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_INVALID");\n\t\t}\n\t\t});', "physical-record-precount");
		patch('const headerEnd = data.indexOf(10);\n\t\tconst header: unknown = JSON.parse(data.toString("utf8", 0, headerEnd));', 'const headerEnd = __cmProfileMeasure("line-scan", () => data.indexOf(10));\n\t\t__cmProfileCount("scannedLines");\n\t\t__cmProfileCount("scannedBytes", headerEnd + 1);\n\t\t__cmProfileCount("decodedBytes", headerEnd);\n\t\tconst header: unknown = __cmProfileMeasure("header-parse", () => JSON.parse(__cmProfileMeasure("utf8-decode", () => data.toString("utf8", 0, headerEnd))));', "byte-header-scan-parse");
		patch('const end = data.indexOf(10, start);\n\t\t\tconst canonical = snapshot?.canonicalLines[nextAncestor];', 'const end = __cmProfileMeasure("line-scan", () => data.indexOf(10, start));\n\t\t\t__cmProfileCount("scannedLines");\n\t\t\t__cmProfileCount("scannedBytes", end + 1 - start);\n\t\t\t__cmProfileCount("diskRecords");\n\t\t\tconst canonical = __cmProfileMeasure("canonical-select", () => snapshot?.canonicalLines[nextAncestor]);', "byte-record-scan-select");
		patch('const exact = canonical !== undefined && data.compare(canonical, 0, canonical.length, start, end) === 0;', 'const exact = canonical !== undefined && __cmProfileMeasure("byte-equality", () => { __cmProfileCount("byteEqualityCalls"); __cmProfileCount("byteEqualityCandidateBytes", canonical.length); return data.compare(canonical, 0, canonical.length, start, end) === 0; });\n\t\t\t__cmProfileCount(exact ? "canonicalMatches" : "canonicalMisses");', "byte-record-equality");
		patch('const entry: unknown = exact ? snapshot?.branch[nextAncestor] : JSON.parse(data.toString("utf8", start, end));', 'const entry: unknown = exact ? snapshot?.branch[nextAncestor] : __cmProfileMeasure("entry-parse", () => { __cmProfileCount("decodedBytes", end - start); return JSON.parse(__cmProfileMeasure("utf8-decode", () => data.toString("utf8", start, end))); });\n\t\t\tconst metadataTimer = __cmProfileEnter("metadata");\n\t\t\ttry {\n\t\t\t__cmProfileCount("metadataRecords");', "byte-record-parse");
		patch('entries.set(entry.id, entry as unknown as SessionEntry);\n\t\t\t// A selected ancestor', 'entries.set(entry.id, entry as unknown as SessionEntry);\n\t\t\t} finally { __cmProfileLeave(metadataTimer); }\n\t\t\t// A selected ancestor', "disk-metadata");
		patch("snapshot && currentSnapshot(snapshot, session.getBranch(), session.getLeafId())", 'snapshot && __cmProfileMeasure("snapshot-match", () => currentSnapshot(snapshot, __cmProfileMeasure("memory-branch", () => session.getBranch()), session.getLeafId()))', "initial-snapshot");
		patch("const disk = readSession(identity, true, current);", 'const disk = __cmProfileMeasure("readback", () => readSession(identity, true, current));', "readback-total");
		patch("const memoryBranch = session.getBranch();\n\t\t\t\t\tconst diskBranch = branchAt(disk, leafId);", 'const memoryBranch = __cmProfileMeasure("memory-branch", () => session.getBranch());\n\t\t\t\t\tconst diskBranch = __cmProfileMeasure("disk-branch", () => branchAt(disk, leafId));', "disk-memory-branch");
		patch("currentSnapshot(snapshot, memoryBranch, leafId) &&\n\t\t\t\t\t\tsameEntries(diskBranch, memoryBranch);", '__cmProfileMeasure("snapshot-match", () => currentSnapshot(snapshot, memoryBranch, leafId)) &&\n\t\t\t\t\t\t__cmProfileMeasure("branch-compare", () => sameEntries(diskBranch, memoryBranch));', "final-snapshot");
		patch('if (!identical && hashEntries(diskBranch) !== hashEntries(memoryBranch))\n\t\t\t\t\t\tthrow new PreviewStoreError("CONTEXT_SOURCE_CHANGED");', 'if (!identical) {\n\t\t\t\t\t\t__cmProfileCount("fallbackBranchComparisons");\n\t\t\t\t\t\tif (__cmProfileMeasure("fallback-hash", () => hashEntries(diskBranch)) !== __cmProfileMeasure("fallback-hash", () => hashEntries(memoryBranch))) throw new PreviewStoreError("CONTEXT_SOURCE_CHANGED");\n\t\t\t\t\t}', "fallback-branch-hash");
	} else return { contents: original, anchors: [], sourceSha256: sha256(original), transformedSha256: sha256(original) };
	return { contents: importLine + source, anchors, sourceSha256: sha256(original), transformedSha256: sha256(importLine + source) };
}

export function instrumentationPlugin(root, transforms, snapshots) {
	return { name: "request-component-diagnostic", setup(builder) {
		builder.onResolve({ filter: /^picompact:request-profile$/ }, () => ({ path: "../profile-collector.mjs", external: true }));
		builder.onLoad({ filter: /context-memory\/(?:identity|notes|preview\/(?:controller|extension|failure-store))\.ts$/ }, ({ path }) => {
			const file = relative(root, path).replaceAll("\\", "/");
			const original = snapshots ? snapshots.get(file) : readFileSync(path, "utf8");
			if (original === undefined) throw new Error("PROFILE_TRANSFORM_SOURCE_MISSING");
			const record = instrumentSource(file, original);
			if (!record.anchors.length) throw new Error("PROFILE_SOURCE_UNEXPECTED");
			transforms.push({ file, sourceSha256: record.sourceSha256, transformedSha256: record.transformedSha256, anchors: record.anchors });
			return { contents: record.contents, loader: "ts" };
		});
	} };
}

export async function buildDiagnosticPackage(packageDir, candidate) {
	const manifest = JSON.parse(readFileSync(join(packageDir, "preview-build.json"), "utf8"));
	assert.equal(manifest.supportedPi, "1.1.0", "PROFILE_CANDIDATE_HOST");
	const hash = createHash("sha256").update("official-pi-1.1.0\0");
	const snapshots = new Map();
	for (const source of manifest.sources) {
		assert(source.file.startsWith(extensionRoot) && !source.file.includes(".."), "PROFILE_SOURCE_PATH");
		assert(source.file.endsWith(".ts"), "PROFILE_SNAPSHOT_LOADER_UNSUPPORTED");
		const bytes = readFileSync(resolve(repository, source.file));
		assert.equal(sha256(bytes), source.sha256, "PROFILE_BASELINE_SOURCE_CHANGED");
		snapshots.set(source.file, bytes.toString("utf8"));
		hash.update(source.file).update("\0").update(bytes).update("\0");
	}
	assert.equal(hash.digest("hex"), manifest.sourceHash, "PROFILE_BASELINE_SOURCE_HASH");
	const options = { absWorkingDir: repository, entryPoints: [`${extensionRoot}preview/extension.ts`], bundle: true, write: false, metafile: true, format: "esm", platform: "node", target: "node22", packages: "external", external: ["@earendil-works/pi-ai", "@earendil-works/pi-ai/*", "@earendil-works/pi-coding-agent", "@earendil-works/pi-coding-agent/*", "typebox", "typebox/*"], tsconfigRaw: { compilerOptions: {} }, sourcemap: false, legalComments: "inline", outfile: "dist/extension.js", logLevel: "silent" };
	const fingerprint = { name: "diagnostic-baseline-fingerprint", setup(builder) { builder.onLoad({ filter: /context-memory\/preview\/build\.ts$/ }, () => ({ contents: `export const PREVIEW_BUILD_ID = ${JSON.stringify(manifest.build)};\n`, loader: "ts" })); } };
	const snapshotPlugin = { name: "diagnostic-source-snapshot", setup(builder) { builder.onLoad({ filter: /\.(?:ts|js|mjs)$/ }, ({ path }) => { const file = relative(repository, path).replaceAll("\\", "/"); const contents = snapshots.get(file); if (contents === undefined) throw new Error("PROFILE_SNAPSHOT_GRAPH_CHANGED"); return { contents, loader: "ts" }; }); } };
	const baseline = await build({ ...options, plugins: [fingerprint, snapshotPlugin] });
	assert.deepEqual(Object.keys(baseline.metafile.inputs).sort(), manifest.sources.map((source) => source.file).sort(), "PROFILE_BASELINE_GRAPH_CHANGED");
	const baselineBundleSha256 = sha256(readFileSync(join(packageDir, "dist/extension.js")));
	assert.equal(sha256(baseline.outputFiles[0].contents), baselineBundleSha256, "PROFILE_BASELINE_BUNDLE_CHANGED");
	const transforms = [];
	const instrumented = await build({ ...options, plugins: [instrumentationPlugin(repository, transforms, snapshots), fingerprint, snapshotPlugin] });
	assert.deepEqual(Object.keys(instrumented.metafile.inputs).sort(), Object.keys(baseline.metafile.inputs).sort(), "PROFILE_INSTRUMENTED_GRAPH_CHANGED");
	assert.equal(transforms.length, 5, "PROFILE_TRANSFORM_GRAPH");
	cpSync(packageDir, candidate, { recursive: true });
	writeFileSync(join(candidate, "dist/extension.js"), instrumented.outputFiles[0].contents);
	const helper = collectorModuleSource();
	writeFileSync(join(candidate, "profile-collector.mjs"), helper);
	return { baseline: { build: manifest.build, sourceHash: manifest.sourceHash, bundleSha256: baselineBundleSha256, sources: manifest.sources }, diagnostic: { version: PROFILE_VERSION, sourceSnapshot: "all baseline sources; both builds use the same verified byte snapshot", instrumentedBundleSha256: sha256(instrumented.outputFiles[0].contents), collectorSha256: sha256(helper), transformScriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), transforms: transforms.sort((a, b) => a.file.localeCompare(b.file)) } };
}

export function instrumentWorker(original) {
	const anchors = [];
	let source = original;
	const patch = (before, after, label) => { source = replaceAnchor(source, before, after, label, anchors); };
	patch("const requests = [];", "const requests = [];\nlet profileHttpCalls = 0;", "http-counter");
	patch("const server = createServer(async (request, response) => {", 'const server = createServer(async (request, response) => {\nif (++profileHttpCalls > 70) { writeFileSync(join(outputDir, "request-count.json"), JSON.stringify({ calls: profileHttpCalls, ceiling: 70, exhausted: true })); process.exit(2); }\nwriteFileSync(join(outputDir, "request-count.json"), JSON.stringify({ calls: profileHttpCalls, ceiling: 70, exhausted: false }));', "http-admission");
	// The same worker and prompt()/probe() code run unchanged. Copy its only local
	// import next to the temporary worker; do not bundle a patched host into it.
	return { contents: source, sha256: sha256(source), anchors };
}

function safeCode(error) { return String(error?.message ?? error).match(/\b(?:PROFILE|CONTEXT|HISTORY)_[A-Z_]+\b/)?.[0] ?? "PROFILE_DIAGNOSTIC_FAILED"; }
function json(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function noShadowing(directory) {
	for (let current = directory; ; current = dirname(current)) {
		for (const peer of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]) if (existsSync(join(current, "node_modules", peer))) throw new Error("PROFILE_SHADOWED_OFFICIAL_HOST");
		if (dirname(current) === current) return;
	}
}

export function safeScenarioResult(value) {
	assert(value && value.case === "long-session-overhead" && value.variant === "extension", "PROFILE_RESULT_INVALID");
	assert(Number.isSafeInteger(value.providerRequests) && value.providerRequests >= 0 && value.providerRequests <= PROFILE_LIMITS.httpCalls, "PROFILE_RESULT_CALLS");
	assert(Array.isArray(value.observations) && value.observations.length <= 8, "PROFILE_RESULT_CAP");
	const observations = (value.observations ?? []).filter((item) => ["raw request timing samples", "overhead per model request"].includes(item.step)).map((item) => {
		if (item.step === "overhead per model request") {
			assert(Array.isArray(item.rows) && item.rows.length <= 2, "PROFILE_RESULT_CAP");
			return { step: item.step, rows: item.rows.map(({ checkpoints, sessionMB, extensionMs, baselineMs, overheadMs }) => { assert([10, 20].includes(checkpoints) && [sessionMB, extensionMs, baselineMs, overheadMs].every((number) => Number.isFinite(number) && number >= 0), "PROFILE_RESULT_NUMBERS"); return { checkpoints, sessionMB, extensionMs, baselineMs, overheadMs }; }) };
		}
		assert([10, 20, "disabled-control"].includes(item.milestone) && item.samplesMs.length === 3 && item.monotonicIntervalsUs.length === 3, "PROFILE_PROBE_SHAPE");
		assert(item.samplesMs.every((number) => Number.isFinite(number) && number >= 0) && item.monotonicIntervalsUs.every(({ beginUs, endUs }) => Number.isSafeInteger(beginUs) && Number.isSafeInteger(endUs) && endUs >= beginUs), "PROFILE_PROBE_CLOCK");
		return { step: item.step, milestone: item.milestone, samplesMs: item.samplesMs, monotonicIntervalsUs: item.monotonicIntervalsUs.map(({ beginUs, endUs }) => ({ beginUs, endUs })) };
	});
	assert(new Set(observations.filter((item) => item.step === "raw request timing samples").map((item) => item.milestone)).size === observations.filter((item) => item.step === "raw request timing samples").length, "PROFILE_PROBE_DUPLICATE");
	return { case: value.case, variant: value.variant, pi: "1.1.0", providerRequests: value.providerRequests, checks: (value.checks ?? []).slice(0, 4).map(({ key, passed }) => ({ key: ["compactions-succeed", "per-request-budget", "bounded-growth"].includes(key) ? key : "harness", passed: Boolean(passed) })), observations };
}

export function readProfileJournal(file) {
	if (!existsSync(file)) return { records: [] };
	if (statSync(file).size > PROFILE_LIMITS.journalBytes) return { records: [], reason: "PROFILE_JOURNAL_CAP" };
	const data = readFileSync(file, "utf8");
	const lines = data.split("\n");
	const records = [];
	const started = new Map();
	const finished = new Set();
	for (let index = 0; index < lines.length; index++) {
		if (!lines[index] && index === lines.length - 1) continue;
		try {
			assert(records.length < PROFILE_LIMITS.hooks * 2 && Buffer.byteLength(lines[index]) <= PROFILE_LIMITS.recordBytes, "PROFILE_JOURNAL_CAP");
			const record = JSON.parse(lines[index]);
			assert(Number.isSafeInteger(record.id) && record.id > 0 && record.id <= PROFILE_LIMITS.hooks && ["context", "context_with_system", "before_provider_request"].includes(record.hook) && ["started", "completed", "failed"].includes(record.state), "PROFILE_JOURNAL_INVALID");
			assert(Number.isSafeInteger(record.beginUs) && (record.state === "started" || Number.isSafeInteger(record.endUs) && record.endUs >= record.beginUs), "PROFILE_JOURNAL_INVALID");
			const required = record.state === "started" ? ["id", "hook", "beginUs", "state"] : ["id", "hook", "state", "beginUs", "endUs", "inclusiveUs", "unattributedUs", "incompleteTimers", "phases", "counters"];
			assert(Object.keys(record).length === required.length && required.every((key) => Object.hasOwn(record, key)), "PROFILE_JOURNAL_INVALID");
			if (record.state === "started") {
				assert(!started.has(record.id), "PROFILE_JOURNAL_OWNERSHIP");
				started.set(record.id, record);
			} else {
				const begin = started.get(record.id);
				assert(begin && !finished.has(record.id) && begin.hook === record.hook && begin.beginUs === record.beginUs, "PROFILE_JOURNAL_OWNERSHIP");
				assert([record.inclusiveUs, record.unattributedUs, record.incompleteTimers].every((number) => Number.isSafeInteger(number) && number >= 0), "PROFILE_JOURNAL_INVALID");
				assert(record.phases && typeof record.phases === "object" && !Array.isArray(record.phases) && record.counters && typeof record.counters === "object" && !Array.isArray(record.counters), "PROFILE_JOURNAL_INVALID");
				finished.add(record.id);
			}
			for (const [name, phase] of Object.entries(record.phases ?? {})) assert(PROFILE_PHASES.includes(name) && phase && Object.keys(phase).sort().join(",") === "calls,exclusiveUs,inclusiveUs" && Object.values(phase).every((number) => Number.isSafeInteger(number) && number >= 0), "PROFILE_JOURNAL_INVALID");
			for (const [name, number] of Object.entries(record.counters ?? {})) assert(PROFILE_COUNTERS.includes(name) && Number.isSafeInteger(number) && number >= 0, "PROFILE_JOURNAL_INVALID");
			if (record.state !== "started") {
				assert(record.inclusiveUs === record.endUs - record.beginUs && Object.values(record.phases ?? {}).every((phase) => phase.exclusiveUs <= phase.inclusiveUs), "PROFILE_TIMING_INCONSISTENT");
				if (record.incompleteTimers === 0) assert(Object.values(record.phases ?? {}).reduce((sum, phase) => sum + phase.exclusiveUs, record.unattributedUs) === record.inclusiveUs, "PROFILE_TIMING_INCONSISTENT");
			}
			records.push(record);
		} catch (error) { return { records, reason: safeCode(error) }; }
	}
	return { records };
}

export function readProfileHttp(file) {
	if (!existsSync(file)) return { http: { calls: 0, ceiling: PROFILE_LIMITS.httpCalls, exhausted: false } };
	try {
		assert(statSync(file).size <= 512, "PROFILE_HTTP_EVIDENCE_CAP");
		const value = JSON.parse(readFileSync(file, "utf8"));
		assert(value && Object.keys(value).sort().join(",") === "calls,ceiling,exhausted" && Number.isSafeInteger(value.calls) && value.calls >= 0 && value.calls <= PROFILE_LIMITS.httpCalls + 1 && value.ceiling === PROFILE_LIMITS.httpCalls && typeof value.exhausted === "boolean", "PROFILE_HTTP_EVIDENCE_INVALID");
		assert(value.exhausted === (value.calls > PROFILE_LIMITS.httpCalls), "PROFILE_HTTP_EVIDENCE_INVALID");
		return { http: { calls: value.calls, ceiling: value.ceiling, exhausted: value.exhausted } };
	} catch { return { http: { calls: null, ceiling: PROFILE_LIMITS.httpCalls, exhausted: null }, reason: "PROFILE_HTTP_EVIDENCE_INVALID" }; }
}

export function attributeProbes(result, records) {
	const completed = records.filter((record) => record.state !== "started");
	const probes = [];
	for (const observation of result?.observations ?? []) {
		if (observation.step !== "raw request timing samples") continue;
		for (const [index, interval] of observation.monotonicIntervalsUs.entries()) {
			const intersecting = completed.filter((record) => record.beginUs < interval.endUs && record.endUs > interval.beginUs);
			const contained = intersecting.filter((record) => record.beginUs >= interval.beginUs && record.endUs <= interval.endUs);
			const hooks = Object.fromEntries(["context", "context_with_system", "before_provider_request"].map((hook) => [hook, contained.filter((record) => record.hook === hook)]));
			probes.push({ milestone: observation.milestone, probe: index + 1, ...interval, hookCounts: Object.fromEntries(Object.entries(hooks).map(([key, rows]) => [key, rows.length])), boundaryCrossingHooks: intersecting.length - contained.length, hooks });
		}
	}
	return { probes, startedHooks: records.filter((record) => record.state === "started").length, completedHooks: completed.length, incompleteHookIds: records.filter((record) => record.state === "started" && !completed.some((row) => row.id === record.id)).map((row) => row.id) };
}

export function dispatchProfileWorker(job) {
	return new Promise((done, reject) => {
		const parameters = [job.worker, "--package-dir", job.candidate, "--stock-root", job.stockRoot, "--output-dir", job.outputDir, "--worker", "long-session-overhead", "--variant", "extension", "--perf-checkpoints", "20"];
		const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", CI: "1", PI_CODING_AGENT_DIR: job.agentDir, PI_OFFLINE: "0", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", npm_config_offline: "true", PICOMPACT_REQUEST_PROFILE_JOURNAL: job.journal };
		if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
		const child = spawn(process.execPath, parameters, { cwd: job.outputDir, env, stdio: ["ignore", "pipe", "pipe"] });
		const outputHash = createHash("sha256");
		let bytes = 0;
		let reason;
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (part) => { bytes += part.length; outputHash.update(part); if (bytes > PROFILE_LIMITS.workerOutputBytes) { reason = "PROFILE_OUTPUT_CAP"; child.kill("SIGKILL"); } });
		const abort = () => { reason = "PROFILE_ABORTED"; child.kill("SIGKILL"); };
		const timer = setTimeout(() => { reason = "PROFILE_DEADLINE"; child.kill("SIGKILL"); }, PROFILE_LIMITS.wallMs);
		process.once("SIGINT", abort);
		process.once("SIGTERM", abort);
		child.once("error", (error) => { clearTimeout(timer); process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); reject(error); });
		child.once("close", (exitCode, signal) => { clearTimeout(timer); process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); done({ exitCode, signal, reason, outputBytes: bytes, outputSha256: outputHash.digest("hex") }); });
	});
}

export async function runRequestProfile(options, dependencies = {}) {
	const inspectHost = dependencies.inspectHost ?? inspectOfficialPi;
	const buildPackage = dependencies.buildPackage ?? buildDiagnosticPackage;
	const dispatch = dependencies.dispatch ?? dispatchProfileWorker;
	mkdirSync(options.outputDir, { recursive: true, mode: 0o700 });
	if (readdirSync(options.outputDir).length) throw new Error("PROFILE_OUTPUT_NOT_EMPTY");
	const ownerFile = join(options.outputDir, "owner.json");
	writeFileSync(ownerFile, JSON.stringify({ kind: PROFILE_VERSION, pid: process.pid }), { flag: "wx", mode: 0o600 });
	let scratch;
	let manifest = { kind: PROFILE_VERSION, acceptance: false, providers: "loopback synthetic only", limits: PROFILE_LIMITS, state: "preparing", measuredPhases: PROFILE_PHASES,
		counterUnits: { serializedCodeUnits: "UTF-16 code units; not UTF-8 bytes", diskBytes: "actual JSONL read Buffer bytes", canonicalEncodedBytes: "fresh canonical UTF-8 Buffer bytes; excludes record LF", scannedBytes: "consumed framing-pass file bytes including LF; excludes the separate precount pass", scannedLines: "physical frames consumed by header/entry traversal; includes header", precountLines: "physical frames counted in the separate full-file limit prepass; includes header", decodedBytes: "UTF-8 input bytes passed to header/fallback decoding; excludes LF", byteEqualityCandidateBytes: "candidate UTF-8 Buffer length submitted for equality; not bytes actually visited" },
		timing: { clock: "process.hrtime.bigint()/1000; monotonic microseconds", inclusive: "Includes child phase time; do not sum nested inclusive rows", exclusive: "Child spans subtracted once; add exclusive rows and unattributedUs within each hook only" },
		scanPasses: "The existing byte prototype preserves a complete record-limit precount, then scans header/entry frames again. line-scan measures every native indexOf call, including EOF. With N entry records the ordinary path makes 2*N+3 searches; scannedBytes counts framing consumption once, not native bytes actually examined.",
		unmeasured: ["GC pauses are not separately timed", "canonical-encode includes Buffer allocation and UTF-8 conversion; those costs are not split", "native equality/search bytes actually visited are unavailable", "checkpoint schema/quote/render and index construction not split within checkpoint-validation residual", "marker and path checks not split within store-evaluate residual", "diagnostic journal IO, counters and timer overhead perturb timing; no production-cost claim"] };
	json(join(options.outputDir, "manifest.json"), manifest);
	let status = { exitCode: null };
	try {
		manifest.host = inspectHost(options.stockRoot, "1.1.0");
		scratch = mkdtempSync(join(tmpdir(), "pi-request-profile-"));
		const candidate = join(scratch, "package");
		noShadowing(candidate);
		Object.assign(manifest, await buildPackage(options.packageDir, candidate));
		const workerBytes = readFileSync(join(repository, "scripts/context-memory-preview-scenarios.mjs"));
		const workerTransform = instrumentWorker(workerBytes.toString("utf8"));
		const worker = join(candidate, "profile-worker.mjs");
		writeFileSync(worker, workerTransform.contents);
		const companion = readFileSync(join(repository, "scripts/context-memory-preview-stock-install.mjs"));
		writeFileSync(join(candidate, "context-memory-preview-stock-install.mjs"), companion);
		manifest.worker = { baselineSha256: sha256(workerBytes), instrumentedSha256: workerTransform.sha256, companionSha256: sha256(companion), anchors: workerTransform.anchors };
		manifest.state = "running";
		json(join(options.outputDir, "manifest.json"), manifest);
		const caseDir = join(options.outputDir, "cases/long-session-overhead--extension");
		mkdirSync(caseDir, { recursive: true, mode: 0o700 });
		const journal = join(options.outputDir, "hooks.jsonl");
		writeFileSync(journal, "", { flag: "wx", mode: 0o600 });
		status = await dispatch({ candidate, worker, stockRoot: options.stockRoot, outputDir: options.outputDir, agentDir: join(caseDir, "agent"), journal });
	} catch (error) {
		status = { ...status, reason: safeCode(error) };
	} finally {
		let preservedAttribution = { probes: [], startedHooks: 0, completedHooks: 0, incompleteHookIds: [] };
		try {
		// Evidence survives any worker failure/timeout; regenerate only synthetic
		// sessions, settings and the temporary diagnostic package.
		const resultFile = join(options.outputDir, "cases/long-session-overhead--extension/result.json");
		let result;
		try { if (existsSync(resultFile)) { result = safeScenarioResult(JSON.parse(readFileSync(resultFile, "utf8"))); json(resultFile, result); } }
		catch (error) { status.reason ??= safeCode(error); rmSync(resultFile, { force: true }); }
		preservedAttribution = attributeProbes(result, []);
		const journal = readProfileJournal(join(options.outputDir, "hooks.jsonl"));
		if (journal.reason) status.reason ??= journal.reason;
		const records = journal.records;
		const journalFile = join(options.outputDir, "hooks.jsonl");
		// Retain safe complete-prefix evidence, plus the rejection code. A partial
		// or unknown-field record must not persist arbitrary output text.
		if (existsSync(journalFile)) writeFileSync(journalFile, records.map((row) => JSON.stringify(row) + "\n").join(""), { mode: 0o600 });
		const attribution = attributeProbes(result, records);
		preservedAttribution = attribution;
		const httpFile = join(options.outputDir, "request-count.json");
		const httpEvidence = readProfileHttp(httpFile);
		if (httpEvidence.reason) status.reason ??= httpEvidence.reason;
		const http = httpEvidence.http;
		if (existsSync(httpFile)) json(httpFile, http);
		const complete = status.exitCode === 0 && !status.reason && !http.exhausted && http.calls === 70 && result?.providerRequests === 70 && attribution.probes.length === 9 && attribution.probes.every((probe) => probe.boundaryCrossingHooks === 0 && Object.values(probe.hookCounts).every((count) => count === (probe.milestone === "disabled-control" ? 0 : 1))) && attribution.incompleteHookIds.length === 0 && records.every((row) => row.state === "started" || row.state === "completed" && row.incompleteTimers === 0);
		const report = { kind: PROFILE_VERSION, acceptance: false, state: complete ? "completed" : "incomplete", worker: status, http, ...attribution };
		json(join(options.outputDir, "report.json"), report);
		manifest = { ...manifest, state: report.state, worker: status };
		json(join(options.outputDir, "manifest.json"), manifest);
		} catch (error) {
			status.reason ??= safeCode(error);
			json(join(options.outputDir, "report.json"), { kind: PROFILE_VERSION, acceptance: false, state: "incomplete", worker: status, http: { calls: null }, ...preservedAttribution });
			json(join(options.outputDir, "manifest.json"), { ...manifest, state: "incomplete", worker: status });
		} finally {
		const resultFile = join(options.outputDir, "cases/long-session-overhead--extension/result.json");
		const caseDir = dirname(resultFile);
		if (existsSync(caseDir)) for (const name of readdirSync(caseDir)) if (name !== "result.json") rmSync(join(caseDir, name), { recursive: true, force: true });
		if (scratch) rmSync(scratch, { recursive: true, force: true });
		rmSync(ownerFile, { force: true });
		}
	}
	return JSON.parse(readFileSync(join(options.outputDir, "report.json"), "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const report = await runRequestProfile(parseProfileArguments(process.argv.slice(2)));
		console.log(JSON.stringify({ acceptance: false, state: report.state, calls: report.http.calls, probes: report.probes.length }));
		if (report.state !== "completed") process.exitCode = 1;
	} catch (error) { console.error(safeCode(error)); process.exitCode = 1; }
}
