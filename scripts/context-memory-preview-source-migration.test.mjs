import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION, hashEntries } from "../packages/coding-agent/src/extensions/context-memory/identity.ts";
import { PRIMARY_PI_VERSION } from "../packages/coding-agent/src/extensions/context-memory/preview/compatibility.ts";
import { assertPreviewSession } from "../packages/coding-agent/src/extensions/context-memory/preview/controller.ts";
import { PreviewFailureStore } from "../packages/coding-agent/src/extensions/context-memory/preview/failure-store.ts";
import { renderNote } from "../packages/compaction-core/src/notes.ts";
import { inspectOfficialPi } from "./context-memory-preview-stock-install.mjs";

// The v0.7.2 rename moves the install source from OLD to NEW. Pi keys Git packages by host and path,
// so these run the real package and settings managers over a local repository that both addresses
// alias. CONTEXT_MEMORY_MIGRATION_STOCK_ROOT swaps in an official Pi's managers; the checkpoint
// guards are always the candidate's. Local aliasing says nothing about GitHub's own redirect.
const stockRoot = process.env.CONTEXT_MEMORY_MIGRATION_STOCK_ROOT && resolve(process.env.CONTEXT_MEMORY_MIGRATION_STOCK_ROOT);
const stockHost = stockRoot && join(stockRoot, "node_modules/@earendil-works/pi-coding-agent");
const stockVersion = stockHost && JSON.parse(readFileSync(join(stockHost, "package.json"), "utf8")).version;
if (stockRoot) inspectOfficialPi(stockRoot, stockVersion);
const { DefaultPackageManager, SettingsManager } = stockHost
	? await import(pathToFileURL(join(stockHost, "dist/index.js")).href)
	: { ...await import("../packages/coding-agent/src/core/package-manager.ts"), ...await import("../packages/coding-agent/src/core/settings-manager.ts") };

// Git may use only the file remotes each fixture maps, and npm installs nothing and skips its version
// check, so nothing here reaches the network and Pi's update path can run.
Object.assign(process.env, { GIT_ALLOW_PROTOCOL: "file", npm_config_update_notifier: "false", npm_config_loglevel: "silent" });
delete process.env.PI_OFFLINE;

const OLD = "git:github.com/youxi-huang/pi-context-compaction";
const NEW = "git:github.com/youxi-huang/slice";
const TAG = "extension-v0.7.1";
const BRANCH = "extension-preview";
const timestamp = "2026-10-25T00:00:00.000Z";
const config = { enabled: true, writerModel: "session", writerEffort: "high", keepRecentTokens: 0, eventLog: false, noteRepair: true, compactAt: 0.75 };

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function json(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function sources(resolved) { return resolved.map((entry) => entry.source); }

// Each call rereads the session file, as a restarted Pi would.
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

// A preview checkpoint over two synthetic entries. "staged" stops after the checkpoint is appended and
// before its commit is recorded, the state an interrupted compaction leaves for recovery.
function protectedSession(agentDir, state = "committed") {
	const directory = join(agentDir, "sessions", state);
	mkdirSync(directory, { recursive: true });
	const file = join(directory, "session.jsonl");
	const header = { type: "session", version: 3, id: `synthetic-${state}`, timestamp, cwd: directory };
	const entries = [
		{ type: "message", id: "source-1", parentId: null, timestamp, message: { role: "user", content: "Use port 4317.", timestamp: 1 } },
		{ type: "message", id: "reply-1", parentId: "source-1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Recorded." }], timestamp: 2 } },
	];
	const write = (lines) => writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	write([header, ...entries]);
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
	const session = openSession(file);
	store.stage(session, store.begin(session), candidate);
	write([header, ...entries, checkpoint]);
	if (state === "committed") store.commit(openSession(file), checkpoint);
	return { file, checkpoint };
}

// The candidate's validator rereads the checkpoint and checks its source hashes; the failure store must be clear.
function assertRecovered(f, saved = f.saved) {
	const session = openSession(saved.file);
	const checkpoint = assertPreviewSession(session, PRIMARY_PI_VERSION);
	assert.equal(checkpoint.entry.id, saved.checkpoint.id);
	assert.deepEqual(checkpoint.memory, saved.checkpoint.details);
	new PreviewFailureStore(f.agentDir).assertReady(session);
}

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "slice-source-migration-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const remote = join(root, "remote");
	for (const path of [agentDir, join(cwd, ".pi"), remote]) mkdirSync(path, { recursive: true });
	process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
	const url = pathToFileURL(remote).href;
	writeFileSync(process.env.GIT_CONFIG_GLOBAL, `[user]\n\tname = Synthetic\n\temail = synthetic@example.invalid\n[advice]\n\tdetachedHead = false\n[url "${url}"]\n\tinsteadOf = https://github.com/youxi-huang/pi-context-compaction\n\tinsteadOf = https://github.com/youxi-huang/slice\n`);
	git(remote, "init", "-b", BRANCH);
	json(join(remote, "package.json"), { name: "pi-context-compaction-preview", version: "0.7.1", private: true, type: "module", pi: { extensions: ["./extension.js"] } });
	writeFileSync(join(remote, "extension.js"), "export default function () {}\n");
	git(remote, "add", ".");
	git(remote, "commit", "-m", "Synthetic package");
	git(remote, "tag", TAG);

	const other = join(root, "unrelated-package");
	mkdirSync(other);
	json(join(other, "package.json"), { name: "synthetic-unrelated", pi: { extensions: [] } });
	const settings = { defaultProvider: "synthetic-provider", retry: { enabled: false, maxRetries: 7 } };
	json(join(agentDir, "settings.json"), { ...settings, packages: [other] });
	json(join(cwd, ".pi", "settings.json"), { syntheticProjectPreference: "keep", packages: [] });
	json(join(agentDir, "pi-context-memory.json"), config);
	const saved = protectedSession(agentDir);
	const kept = [join(agentDir, "pi-context-memory.json"), join(other, "package.json"), saved.file].map((file) => [file, readFileSync(file)]);

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	// Every change must leave the extension configuration, the session, other packages and other settings intact.
	const intact = () => {
		for (const [file, bytes] of kept) assert.deepEqual(readFileSync(file), bytes, `Changed ${file}`);
		const user = readJson(join(agentDir, "settings.json"));
		assert.deepEqual({ defaultProvider: user.defaultProvider, retry: user.retry }, settings);
		assert(user.packages.includes(other));
		assert.equal(readJson(join(cwd, ".pi", "settings.json")).syntheticProjectPreference, "keep");
	};
	return {
		agentDir, cwd, saved, pm, settingsManager, intact,
		head: git(remote, "rev-parse", "HEAD"),
		path: (source, local = false) => pm.getInstalledPath(source, local ? "project" : "user"),
		declared: (local = false) => readJson(local ? join(cwd, ".pi", "settings.json") : join(agentDir, "settings.json")).packages.filter((entry) => entry !== other),
		install: async (source, local = false) => { await pm.installAndPersist(source, { local }); await settingsManager.flush(); intact(); },
		remove: async (source, local = false) => { const removed = await pm.removeAndPersist(source, { local }); await settingsManager.flush(); intact(); return removed; },
		update: async (source) => { await pm.update(source); intact(); },
		// Fresh managers resolve what a restarted Pi would load.
		resolved: async () => {
			const fresh = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
			const { extensions } = await fresh.resolve(() => assert.fail("Resolution must not install a missing source"));
			return extensions.filter((entry) => entry.enabled).map((entry) => entry.metadata);
		},
		advance: () => {
			writeFileSync(join(remote, "revision.txt"), "Synthetic branch advance.\n");
			git(remote, "add", ".");
			git(remote, "commit", "-m", "Synthetic branch advance");
			return git(remote, "rev-parse", "HEAD");
		},
	};
}

describe(`repository-source migration on ${stockVersion ? `official Pi ${stockVersion}` : "the repository host"}`, () => {
	for (const ref of [TAG, BRANCH]) {
		test(`remove the old address, install the new one (${ref})`, async (t) => {
			const f = fixture(t);
			await f.install(`${OLD}@${ref}`);
			const oldPath = f.path(OLD);
			// The documented command removes without a ref.
			assert.equal(await f.remove(OLD), true);
			assert(!existsSync(oldPath));
			assert.deepEqual(await f.resolved(), [], "Nothing guards a session between the two commands");
			await f.install(`${NEW}@${ref}`);
			const newPath = f.path(NEW);
			assert.notEqual(newPath, oldPath);
			assert.deepEqual(f.declared(), [`${NEW}@${ref}`]);
			assert.deepEqual(sources(await f.resolved()), [`${NEW}@${ref}`]);
			// The tag stays pinned and the branch keeps following its channel at the new address.
			const advanced = f.advance();
			await f.update(`${NEW}@${ref}`);
			assert.equal(git(newPath, "rev-parse", "HEAD"), ref === BRANCH ? advanced : f.head);
			assertRecovered(f);
		});
	}

	test("both addresses installed: two resources, and removing either keeps the other", async (t) => {
		const f = fixture(t);
		await f.install(`${OLD}@${BRANCH}`);
		await f.install(`${NEW}@${BRANCH}`);
		const oldPath = f.path(OLD);
		const newPath = f.path(NEW);
		assert.notEqual(oldPath, newPath);
		assert.equal(git(oldPath, "rev-parse", "HEAD"), git(newPath, "rev-parse", "HEAD"));
		assert.deepEqual(sources(await f.resolved()), [`${OLD}@${BRANCH}`, `${NEW}@${BRANCH}`], "One commit and one manifest name do not merge two addresses");
		assert.equal(await f.remove(OLD), true);
		assert(!existsSync(oldPath));
		assert.deepEqual(sources(await f.resolved()), [`${NEW}@${BRANCH}`]);
		await f.install(`${OLD}@${BRANCH}`);
		assert.equal(await f.remove(NEW), true);
		assert(!existsSync(newPath));
		assert.deepEqual(sources(await f.resolved()), [`${OLD}@${BRANCH}`]);
		assertRecovered(f);
	});

	test("scopes: one address dedupes across them, two addresses do not, and -l selects the project", async (t) => {
		const f = fixture(t);
		await f.install(`${OLD}@${TAG}`);
		await f.install(`${OLD}@${BRANCH}`, true);
		const userPath = f.path(OLD);
		const projectPath = f.path(OLD, true);
		assert.notEqual(userPath, projectPath);
		assert.deepEqual((await f.resolved()).map((entry) => entry.scope), ["project"]);
		await f.install(`${NEW}@${BRANCH}`, true);
		const projectSettings = readFileSync(join(f.cwd, ".pi", "settings.json"));
		assert.equal(await f.remove(OLD), true);
		assert.deepEqual(readFileSync(join(f.cwd, ".pi", "settings.json")), projectSettings);
		assert(!existsSync(userPath));
		assert.deepEqual(sources(await f.resolved()), [`${OLD}@${BRANCH}`, `${NEW}@${BRANCH}`]);
		assert.equal(await f.remove(OLD), false);
		await f.install(`${OLD}@${TAG}`);
		const userSettings = readFileSync(join(f.agentDir, "settings.json"));
		assert.equal(await f.remove(OLD, true), true);
		assert.deepEqual(readFileSync(join(f.agentDir, "settings.json")), userSettings);
		assert(existsSync(userPath));
		assert(!existsSync(projectPath));
		assert.equal(await f.remove(OLD), true);
		assert.deepEqual(sources(await f.resolved()), [`${NEW}@${BRANCH}`]);
		assertRecovered(f);
	});

	test("an object-form resource filter is not carried to the new address", async (t) => {
		const f = fixture(t);
		await f.install(`${OLD}@${BRANCH}`);
		const filtered = { source: `${OLD}@${BRANCH}`, extensions: [] };
		f.settingsManager.setPackages([...f.settingsManager.getGlobalSettings().packages.filter((entry) => entry !== `${OLD}@${BRANCH}`), filtered]);
		await f.settingsManager.flush();
		assert.deepEqual(await f.resolved(), []);
		// A new ref on the same address keeps the filter; a new address starts without it.
		await f.install(`${OLD}@${TAG}`);
		assert.deepEqual(f.declared(), [{ ...filtered, source: `${OLD}@${TAG}` }]);
		await f.remove(OLD);
		await f.install(`${NEW}@${BRANCH}`);
		assert.deepEqual(f.declared(), [`${NEW}@${BRANCH}`]);
		assert.equal((await f.resolved()).length, 1);
		assertRecovered(f);
	});

	test("a failed install of the new address leaves no declaration and loses nothing", async (t) => {
		const f = fixture(t);
		await f.install(`${OLD}@${BRANCH}`);
		await f.remove(OLD);
		await assert.rejects(f.pm.installAndPersist(`${NEW}@synthetic-missing-ref`));
		await f.settingsManager.flush();
		assert.deepEqual(f.declared(), []);
		assert.equal(f.path(NEW), undefined);
		f.intact();
		await f.install(`${NEW}@${BRANCH}`);
		assertRecovered(f);
	});

	test("an interrupted or failed compaction stays guarded through the switch", async (t) => {
		const f = fixture(t);
		await f.install(`${OLD}@${BRANCH}`);
		const staged = protectedSession(f.agentDir, "staged");
		new PreviewFailureStore(f.agentDir).fail(openSession(f.saved.file), "CONTEXT_WRITER_FAILED");
		await f.remove(OLD);
		await f.install(`${NEW}@${BRANCH}`);
		// A fresh store reads both states from disk: the reinstall cleared neither.
		const store = new PreviewFailureStore(f.agentDir);
		assert.throws(() => store.assertReady(openSession(f.saved.file)), /CONTEXT_WRITER_FAILED/);
		assert.throws(() => store.assertReady(openSession(staged.file)), /CONTEXT_PREVIEW_PENDING/);
		store.recover(openSession(staged.file), staged.checkpoint);
		assertRecovered(f, staged);
	});
});
