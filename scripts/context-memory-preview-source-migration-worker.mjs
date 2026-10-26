import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { readMemoryConfig } from "../packages/coding-agent/src/extensions/context-memory/config.ts";
import { CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION, hashEntries } from "../packages/coding-agent/src/extensions/context-memory/identity.ts";
import { PRIMARY_PI_VERSION } from "../packages/coding-agent/src/extensions/context-memory/preview/compatibility.ts";
import { assertPreviewSession } from "../packages/coding-agent/src/extensions/context-memory/preview/controller.ts";
import { PreviewFailureStore } from "../packages/coding-agent/src/extensions/context-memory/preview/failure-store.ts";
import { renderNote } from "../packages/compaction-core/src/notes.ts";

// Only package/settings APIs switch hosts. Recovery below deliberately uses the candidate's
// source guards and synthetic session surface; this is not installed-artifact acceptance.
const { DefaultPackageManager, SettingsManager } = process.env.CONTEXT_MEMORY_MIGRATION_STOCK_SDK
	? await import(pathToFileURL(process.env.CONTEXT_MEMORY_MIGRATION_STOCK_SDK).href)
	: {
		...await import("../packages/coding-agent/src/core/package-manager.ts"),
		...await import("../packages/coding-agent/src/core/settings-manager.ts"),
	};

const OLD = "git:github.com/youxi-huang/pi-context-compaction";
const NEW = "git:github.com/youxi-huang/slice";
const refs = ["extension-v0.7.1", "extension-preview"];
const timestamp = "2026-10-25T00:00:00.000Z";
const config = { enabled: true, writerModel: "session", writerEffort: "high", keepRecentTokens: 0, eventLog: false, noteRepair: true, compactAt: 0.75 };

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, env: process.env, encoding: "utf8", timeout: 10_000 });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function json(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function sourceOf(value) { return typeof value === "string" ? value : value.source; }

// Read a fresh public session surface from disk on every reopen. This is NOT the patched
// resident SessionManager, nor an assertion that a real official host loaded the extension.
function openSession(file) {
	const [header, ...entries] = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
	return {
		getSessionId: () => header.id, getSessionFile: () => file, getSessionDir: () => dirname(file),
		getCwd: () => header.cwd, getHeader: () => header, getEntries: () => [...entries],
		getBranch: () => [...entries], getLeafId: () => entries.at(-1)?.id ?? null,
		getEntry: (id) => entries.find((entry) => entry.id === id),
		getLeafEntry: () => entries.at(-1),
	};
}

function protectedSession(agentDir, state = "committed") {
	const directory = join(agentDir, "sessions", state);
	mkdirSync(directory, { recursive: true });
	const file = join(directory, "session.jsonl");
	const header = { type: "session", version: 3, id: `synthetic-${state}`, timestamp, cwd: directory };
	const entries = [
		{ type: "message", id: "source-1", parentId: null, timestamp, message: { role: "user", content: "Use port 4317.", timestamp: 1 } },
		{ type: "message", id: "reply-1", parentId: "source-1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Recorded." }], timestamp: 2 } },
	];
	const persist = () => writeFileSync(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	persist();
	const session = openSession(file);
	const note = { instructions: [], failedPaths: [], reasons: [], state: [{ text: "Use port 4317.", sources: ["source-1"] }], nextSteps: [], files: [], gaps: [] };
	const candidate = {
		summary: renderNote(note), firstKeptEntryId: "reply-1", tokensBefore: 2000,
		details: {
			kind: CONTEXT_MEMORY_KIND, version: CONTEXT_MEMORY_VERSION, note,
			coveredThrough: "reply-1", sourceHash: hashEntries(entries),
			snapshot: { sessionId: header.id, leafId: "reply-1", lastCheckpointId: null },
			writerModel: "synthetic/writer", chunkCount: 1, build: "stock-preview+synthetic-migration",
		},
	};
	const checkpoint = { type: "compaction", id: "checkpoint-1", parentId: "reply-1", timestamp, ...candidate, fromHook: true };
	const store = new PreviewFailureStore(agentDir);
	store.stage(session, store.begin(session), candidate);
	if (state !== "pending") { entries.push(checkpoint); persist(); }
	if (state === "committed") store.commit(openSession(file), checkpoint);
	return { file, checkpoint };
}

function assertRecovered(f, saved) {
	const session = openSession(saved.file);
	// Use the actual preview validator, including original-source hashes, not marker absence alone.
	const checkpoint = assertPreviewSession(session, PRIMARY_PI_VERSION);
	assert.equal(checkpoint.entry.id, saved.checkpoint.id);
	assert.deepEqual(checkpoint.memory, saved.checkpoint.details);
	assert.equal(checkpoint.memory.kind, "pi-context-memory");
	assert.equal(checkpoint.memory.version, 1);
	new PreviewFailureStore(f.agentDir).assertReady(session);
	assert.deepEqual(readMemoryConfig(f.agentDir), config);
}

function fixture(t) {
	assert.equal(process.env.GIT_ALLOW_PROTOCOL, "file");
	assert.equal(process.env.EVAL_MODEL_CALL_BUDGET, "0");
	const root = mkdtempSync(join(process.cwd(), "case-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const remote = join(root, "remote");
	for (const path of [agentDir, join(cwd, ".pi"), remote]) mkdirSync(path, { recursive: true });
	// Both public spellings resolve to the same LOCAL tree. This models aliasing, not GitHub redirects.
	const url = pathToFileURL(remote).href;
	writeFileSync(process.env.GIT_CONFIG_GLOBAL, `[advice]\n\tdetachedHead = false\n[url "${url}"]\n\tinsteadOf = https://github.com/youxi-huang/pi-context-compaction\n\tinsteadOf = https://github.com/youxi-huang/slice\n`);
	git(remote, "init", "-b", "extension-preview");
	git(remote, "config", "user.name", "Synthetic migration");
	git(remote, "config", "user.email", "synthetic@example.invalid");
	json(join(remote, "package.json"), { name: "pi-context-compaction-preview", version: "0.7.1", private: true, type: "module", pi: { extensions: ["./extension.js"] } });
	writeFileSync(join(remote, "extension.js"), "// Discovery fixture only: no runtime loading claim.\nexport default function () {}\n");
	git(remote, "add", "."); git(remote, "commit", "-m", "Synthetic initial package");
	git(remote, "tag", refs[0]);
	const initialHead = git(remote, "rev-parse", "HEAD");
	const preserved = { defaultProvider: "synthetic-provider", retry: { enabled: false, maxRetries: 7 }, syntheticPreference: { value: "keep" } };
	const other = join(root, "unrelated-package");
	mkdirSync(other);
	json(join(other, "package.json"), { name: "synthetic-unrelated", pi: { extensions: [] } });
	json(join(agentDir, "settings.json"), { ...preserved, packages: [other] });
	json(join(cwd, ".pi", "settings.json"), { syntheticProjectPreference: "keep", packages: [] });
	json(join(agentDir, "pi-context-memory.json"), config);
	const saved = protectedSession(agentDir);
	const unchanged = new Map([join(agentDir, "pi-context-memory.json"), join(other, "package.json"), saved.file].map((file) => [file, readFileSync(file)]));
	function managers() {
		const settings = SettingsManager.create(cwd, agentDir);
		return { settings, pm: new DefaultPackageManager({ cwd, agentDir, settingsManager: settings }) };
	}
	const f = { root, agentDir, cwd, remote, initialHead, saved, ...managers(), managers };
	f.preserved = () => {
		for (const [file, bytes] of unchanged) assert.deepEqual(readFileSync(file), bytes, `Changed ${file}`);
		const disk = readJson(join(agentDir, "settings.json"));
		for (const [key, value] of Object.entries(preserved)) assert.deepEqual(disk[key], value);
		assert(disk.packages.includes(other));
		assert.equal(readJson(join(cwd, ".pi", "settings.json")).syntheticProjectPreference, "keep");
	};
	f.install = async (source, local = false) => { await f.pm.installAndPersist(source, { local }); await f.settings.flush(); f.preserved(); };
	f.update = async (source) => {
		// PI_OFFLINE would make update a no-op. The preloaded Node network denial remains
		// installed; Git can still use ONLY the explicitly mapped local file transport.
		process.env.PI_OFFLINE = "0";
		try { await f.pm.update(source); } finally { process.env.PI_OFFLINE = "1"; }
		assert.throws(() => fetch("https://example.invalid"), /EVAL_NETWORK_FORBIDDEN/);
		f.preserved();
	};
	f.remove = async (source, local = false) => { const changed = await f.pm.removeAndPersist(source, { local }); await f.settings.flush(); f.preserved(); return changed; };
	f.paths = async () => (await f.managers().pm.resolve(() => assert.fail("Resolution must not install a missing source"))).extensions.filter((entry) => entry.enabled);
	f.sources = (local = false) => readJson(local ? join(cwd, ".pi", "settings.json") : join(agentDir, "settings.json")).packages.map(sourceOf).filter((source) => source !== other);
	f.advance = () => {
		writeFileSync(join(remote, "revision.txt"), "Synthetic branch advance.\n");
		git(remote, "add", "."); git(remote, "commit", "-m", "Synthetic branch advance");
		return git(remote, "rev-parse", "HEAD");
	};
	return f;
}

test("network denial is active for Node and unmapped Git URLs", () => {
	assert.throws(() => fetch("https://example.invalid"), /EVAL_NETWORK_FORBIDDEN/);
	const probe = spawnSync("git", ["ls-remote", "https://example.invalid/owner/repo"], { encoding: "utf8", timeout: 5000 });
	assert.equal(probe.status, 128);
	assert.match(probe.stderr, /transport 'https' not allowed/);
});

for (const ref of refs) {
	for (const local of [false, true]) {
		const label = `${ref}, ${local ? "project" : "user"}`;
		const scope = local ? "project" : "user";
		test(`retain old source: update, reopen and scoped removal (${label})`, async (t) => {
			const f = fixture(t);
			const source = `${OLD}@${ref}`;
			await f.install(source, local);
			const path = f.pm.getInstalledPath(source, scope);
			assert(path);
			const advanced = f.advance();
			await f.update(source);
			assert.equal(git(path, "rev-parse", "HEAD"), ref === "extension-preview" ? advanced : f.initialHead);
			assert.deepEqual(f.sources(local), [source]);
			assert.equal((await f.paths()).length, 1);
			assertRecovered(f, f.saved);
			assert.equal(await f.remove(OLD, local), true); // ref is deliberately omitted
			assert(!existsSync(path));
			assert.deepEqual(f.sources(local), []);
			assert.equal((await f.paths()).length, 0);
			assertRecovered(f, f.saved);
		});

		test(`remove old, install new: preserve state and checkpoint (${label})`, async (t) => {
			const f = fixture(t);
			await f.install(`${OLD}@${ref}`, local);
			const oldPath = f.pm.getInstalledPath(OLD, scope);
			assert.equal(await f.remove(OLD, local), true);
			assert(!existsSync(oldPath));
			assert.equal((await f.paths()).length, 0); // the gap is real: do not continue a protected session here
			await f.install(`${NEW}@${ref}`, local);
			const newPath = f.pm.getInstalledPath(NEW, scope);
			assert.notEqual(newPath, oldPath);
			assert.deepEqual(f.sources(local), [`${NEW}@${ref}`]);
			assert.deepEqual((await f.paths()).map((entry) => entry.metadata.source), [`${NEW}@${ref}`]);
			assert.equal(readJson(join(newPath, "package.json")).name, "pi-context-compaction-preview");
			const advanced = f.advance();
			await f.update(`${NEW}@${ref}`);
			assert.equal(git(newPath, "rev-parse", "HEAD"), ref === "extension-preview" ? advanced : f.initialHead);
			assertRecovered(f, f.saved);
		});

		test(`both sources: distinct resources, either removal keeps the survivor (${label})`, async (t) => {
			const f = fixture(t);
			await f.install(`${OLD}@${ref}`, local);
			await f.install(`${NEW}@${ref}`, local);
			const oldPath = f.pm.getInstalledPath(OLD, scope);
			const newPath = f.pm.getInstalledPath(NEW, scope);
			assert.notEqual(oldPath, newPath);
			assert.equal(git(oldPath, "rev-parse", "HEAD"), git(newPath, "rev-parse", "HEAD"));
			assert.deepEqual(f.sources(local), [`${OLD}@${ref}`, `${NEW}@${ref}`]);
			assert.equal((await f.paths()).length, 2, "An identical tree and manifest name do not dedupe host/path identities");
			const newManifest = readFileSync(join(newPath, "package.json"));
			assert.equal(await f.remove(OLD, local), true);
			assert(!existsSync(oldPath));
			assert.deepEqual(readFileSync(join(newPath, "package.json")), newManifest);
			assert.deepEqual((await f.paths()).map((entry) => entry.metadata.source), [`${NEW}@${ref}`]);
			assertRecovered(f, f.saved);
			await f.install(`${OLD}@${ref}`, local);
			assert.equal(await f.remove(NEW, local), true);
			assert(!existsSync(newPath));
			assert(existsSync(oldPath));
			assert.deepEqual((await f.paths()).map((entry) => entry.metadata.source), [`${OLD}@${ref}`]);
			assertRecovered(f, f.saved);
		});
	}
}

test("same repository refs dedupe across scopes; renamed repositories do not; remove respects -l", async (t) => {
	const f = fixture(t);
	await f.install(`${OLD}@${refs[0]}`);
	await f.install(`${OLD}@extension-preview`, true);
	const userPath = f.pm.getInstalledPath(OLD, "user");
	const projectPath = f.pm.getInstalledPath(OLD, "project");
	assert.notEqual(userPath, projectPath);
	assert.deepEqual((await f.paths()).map((entry) => entry.metadata.scope), ["project"]);
	await f.install(`${NEW}@extension-preview`, true);
	assert.equal((await f.paths()).length, 2);
	const projectSettings = readFileSync(join(f.cwd, ".pi", "settings.json"));
	assert.equal(await f.remove(OLD), true);
	assert.deepEqual(readFileSync(join(f.cwd, ".pi", "settings.json")), projectSettings);
	assert(!existsSync(userPath));
	assert(existsSync(projectPath));
	assert.equal((await f.paths()).length, 2, "Global removal must not clear project declarations");
	assert.equal(await f.remove(OLD), false);
	await f.install(`${OLD}@${refs[0]}`);
	const globalSettings = readFileSync(join(f.agentDir, "settings.json"));
	assert.equal(await f.remove(OLD, true), true);
	assert.deepEqual(readFileSync(join(f.agentDir, "settings.json")), globalSettings);
	assert(existsSync(userPath));
	assert(!existsSync(projectPath));
	assert.equal((await f.paths()).length, 2, "Project removal must not clear global declarations");
	assert.equal(await f.remove(OLD), true);
	assert.deepEqual((await f.paths()).map((entry) => entry.metadata.source), [`${NEW}@extension-preview`]);
	assertRecovered(f, f.saved);
});

test("per-source resource filters are not silently transferred to a new identity", async (t) => {
	const f = fixture(t);
	await f.install(`${OLD}@extension-preview`);
	const filtered = { source: `${OLD}@extension-preview`, extensions: [] };
	f.settings.setPackages([filtered]); await f.settings.flush();
	assert.equal((await f.paths()).length, 0);
	await f.pm.installAndPersist(`${OLD}@${refs[0]}`); await f.settings.flush();
	assert.deepEqual(f.settings.getGlobalSettings().packages, [{ ...filtered, source: `${OLD}@${refs[0]}` }]);
	await f.pm.removeAndPersist(OLD); await f.pm.installAndPersist(`${NEW}@extension-preview`); await f.settings.flush();
	assert.deepEqual(f.settings.getGlobalSettings().packages, [`${NEW}@extension-preview`]);
	assert.equal((await f.paths()).length, 1, "A custom package filter needs an explicit transfer by the user");
	assertRecovered(f, f.saved);
});

test("a failed new-source install preserves data and leaves no false installation declaration", async (t) => {
	const f = fixture(t);
	await f.install(`${OLD}@extension-preview`);
	await f.remove(OLD);
	await assert.rejects(() => f.pm.installAndPersist(`${NEW}@synthetic-missing-ref`));
	await f.settings.flush();
	assert.deepEqual(f.sources(), []);
	assert.equal(f.pm.getInstalledPath(NEW, "user"), undefined);
	f.preserved();
	await f.install(`${NEW}@extension-preview`);
	assertRecovered(f, f.saved);
});

test("a failed compaction stays blocked across source replacement", async (t) => {
	const f = fixture(t);
	await f.install(`${OLD}@extension-preview`);
	new PreviewFailureStore(f.agentDir).fail(openSession(f.saved.file), "CONTEXT_WRITER_FAILED");
	const marker = join(f.agentDir, "context-memory-preview", "failures", `${createHash("sha256").update(openSession(f.saved.file).getSessionId()).digest("hex")}.json`);
	const bytes = readFileSync(marker);
	await f.remove(OLD); await f.install(`${NEW}@extension-preview`);
	assert.deepEqual(readFileSync(marker), bytes);
	const reopened = openSession(f.saved.file);
	assert.equal(assertPreviewSession(reopened, PRIMARY_PI_VERSION).entry.id, f.saved.checkpoint.id);
	assert.throws(() => new PreviewFailureStore(f.agentDir).assertReady(reopened), /CONTEXT_WRITER_FAILED/);
});

for (const state of ["unobserved", "pending", "tampered-source", "tampered-checkpoint"]) {
	test(`migration preserves the recovery guard: ${state}`, async (t) => {
		const f = fixture(t);
		await f.install(`${OLD}@extension-preview`);
		const saved = protectedSession(f.agentDir, state === "pending" ? "pending" : "unobserved");
		const marker = join(f.agentDir, "context-memory-preview", "failures", `${createHash("sha256").update(openSession(saved.file).getSessionId()).digest("hex")}.json`);
		const markerBytes = readFileSync(marker);
		const sessionBytes = readFileSync(saved.file);
		await f.remove(OLD); await f.install(`${NEW}@extension-preview`);
		assert.deepEqual(readFileSync(marker), markerBytes);
		assert.deepEqual(readFileSync(saved.file), sessionBytes);
		const reopened = openSession(saved.file);
		const store = new PreviewFailureStore(f.agentDir);
		assert.equal(store.status(reopened).state, "pending", "Reinstall must never clear an outstanding attempt");
		assert.throws(() => store.assertReady(reopened), /CONTEXT_PREVIEW_PENDING/);
		if (state === "unobserved") {
			store.recover(reopened, saved.checkpoint);
			assert(!existsSync(marker));
			assertRecovered(f, saved);
		} else {
			if (state === "tampered-source") writeFileSync(saved.file, sessionBytes.toString().replace("Use port 4317.", "Use port 9000."));
			if (state === "tampered-checkpoint") writeFileSync(saved.file, sessionBytes.toString().replace('"tokensBefore":2000', '"tokensBefore":2001'));
			assert.throws(() => store.recover(openSession(saved.file), saved.checkpoint), state === "tampered-source" ? /CONTEXT_SOURCE_CHANGED/ : /CONTEXT_PREVIEW_COMMIT_UNCONFIRMED/);
			assert(existsSync(marker));
			assert.equal(new PreviewFailureStore(f.agentDir).status(openSession(saved.file)).state, "blocked");
		}
	});
}
