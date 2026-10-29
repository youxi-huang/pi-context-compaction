import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readMemoryConfig } from "../packages/coding-agent/src/extensions/context-memory/config.ts";
import { readExcerptSettings } from "../packages/coding-agent/src/extensions/context-memory/preview/excerpts.ts";
import { readPreparationSettings } from "../packages/coding-agent/src/extensions/context-memory/preview/preparation.ts";
// Importing the bench starts no run: only its helpers are read here.
import { parseSessionSettings, writeUnitSettings } from "./context-memory-preview-bench.mjs";

const script = fileURLToPath(new URL("./context-memory-preview-bench.mjs", import.meta.url));

function scratch(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-preview-bench-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

const settingsFile = (agentDir) => join(agentDir, "pi-context-memory.json");

test("a unit's pi-context-memory.json carries each named switch in the shape the preview reads", (t) => {
	const { label, settings } = parseSessionSettings("previewReduction=on,previewExcerpts=off");
	// The label stays as given, for summary.json; the file holds the preview's own switch objects.
	assert.deepEqual(label, { previewReduction: "on", previewExcerpts: "off" });
	assert.deepEqual(settings, { previewReduction: { enabled: true }, previewExcerpts: { enabled: false } });

	const agentDir = join(scratch(t), "agents", "0001");
	writeUnitSettings(agentDir, settings);
	assert.deepEqual(JSON.parse(readFileSync(settingsFile(agentDir), "utf8")), settings);
	// The preview's readers accept it: the named switches take effect and nothing else is disturbed.
	assert.deepEqual(readPreparationSettings(agentDir), {
		enabled: false,
		notes: { enabled: false },
		reduction: { enabled: true },
		rendering: { enabled: false, candidates: [] },
	});
	assert.deepEqual(readExcerptSettings(agentDir), { enabled: false });
	assert.equal(readMemoryConfig(agentDir).enabled, true);

	// All four switches map, and the file lists them in one fixed order whatever order the flag gives.
	const every = parseSessionSettings("previewWorkNotes=on,previewPreparation=off,previewExcerpts=on,previewReduction=on");
	assert.deepEqual(Object.keys(every.label), ["previewWorkNotes", "previewPreparation", "previewExcerpts", "previewReduction"]);
	assert.deepEqual(every.settings, {
		previewReduction: { enabled: true },
		previewExcerpts: { enabled: true },
		previewPreparation: { enabled: false },
		previewWorkNotes: { enabled: true },
	});
	const everyDir = join(scratch(t), "every");
	writeUnitSettings(everyDir, every.settings);
	assert.deepEqual(readPreparationSettings(everyDir), {
		enabled: false,
		notes: { enabled: true },
		reduction: { enabled: true },
		rendering: { enabled: false, candidates: [] },
	});
	assert.deepEqual(readExcerptSettings(everyDir), { enabled: true });

	// Merged over what the unit's file already holds; a named switch replaces its earlier value.
	const merged = join(scratch(t), "merged");
	mkdirSync(merged, { recursive: true });
	writeFileSync(settingsFile(merged), JSON.stringify({ eventLog: false, previewReduction: { enabled: false } }));
	writeUnitSettings(merged, settings);
	assert.deepEqual(JSON.parse(readFileSync(settingsFile(merged), "utf8")), {
		eventLog: false,
		previewReduction: { enabled: true },
		previewExcerpts: { enabled: false },
	});
});

test("an unknown name or value is a usage error, and the run stops before any unit starts", (t) => {
	for (const [text, message] of [
		["previewReducton=on", /unknown setting "previewReducton"/],
		["keepRecentTokens=0", /unknown setting "keepRecentTokens"/],
		["previewReduction=yes", /previewReduction takes on or off, not "yes"/],
		["previewReduction=true", /previewReduction takes on or off/],
		["previewReduction=on,previewReduction=off", /previewReduction is given twice/],
		["previewReduction", /name=on\|off pairs/],
		["previewReduction=on=off", /name=on\|off pairs/],
	])
		assert.throws(() => parseSessionSettings(text), message, text);

	// The whole bench, with a package and host that do not exist: the flag is refused before either is read and
	// before the run directory, and so any unit's agent directory, is created.
	const directory = scratch(t);
	const output = join(directory, "output");
	const result = spawnSync(
		process.execPath,
		[
			script,
			"--package-dir",
			join(directory, "no-package"),
			"--stock-root",
			join(directory, "no-pi"),
			"--output-dir",
			output,
			"--mode",
			"writer",
			"--label",
			"mislabelled",
			"--session-settings",
			"previewReduction=on,previewReducton=on",
		],
		{ encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1" } },
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /--session-settings: unknown setting "previewReducton"/);
	assert.doesNotMatch(result.stderr, /preview-build\.json|ENOENT/);
	assert.equal(existsSync(output), false);
});

test("without --session-settings no unit gets a settings file, so units run on the package defaults", (t) => {
	assert.deepEqual(parseSessionSettings(""), { label: {}, settings: {} });
	assert.deepEqual(parseSessionSettings(","), { label: {}, settings: {} });
	const agentDir = join(scratch(t), "agents", "0001");
	writeUnitSettings(agentDir, parseSessionSettings("").settings);
	assert.equal(existsSync(agentDir), false);
	assert.equal(existsSync(settingsFile(agentDir)), false);
	// What a unit without the file reads: every preview switch at its off default.
	assert.deepEqual(readPreparationSettings(agentDir), {
		enabled: false,
		notes: { enabled: false },
		reduction: { enabled: false },
		rendering: { enabled: false, candidates: [] },
	});
	assert.deepEqual(readExcerptSettings(agentDir), { enabled: false });
});

test("--provider openai is a provider run on the official API: limits required, no repair mode, codex gone", (t) => {
	const directory = scratch(t);
	const output = join(directory, "output");
	const bench = (...flags) =>
		spawnSync(
			process.execPath,
			[script, "--package-dir", join(directory, "no-package"), "--stock-root", join(directory, "no-pi"), "--output-dir", output, ...flags],
			{ encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1" } },
		);
	// Each is refused before the package, the host or the run directory is read, so no request can follow.
	for (const [flags, message] of [
		[["--mode", "smoke", "--provider", "openai"], /Missing --max-requests/],
		[["--mode", "smoke", "--provider", "openai", "--max-requests", "1", "--max-minutes", "1", "--max-cost-usd", "0"], /--max-costUsd must be positive for a provider run/],
		[["--mode", "repair", "--provider", "openai", "--max-requests", "1", "--max-minutes", "1", "--max-cost-usd", "0.01"], /--provider openai does not serve --mode repair/],
		[["--mode", "smoke", "--provider", "codex"], /--provider must be loopback, deepseek, deepseek-local, openai or relay/],
	]) {
		const result = bench(...flags);
		assert.notEqual(result.status, 0, flags.join(" "));
		assert.match(result.stderr, message, flags.join(" "));
		assert.doesNotMatch(result.stderr, /preview-build\.json|ENOENT/, flags.join(" "));
		assert.equal(existsSync(output), false, flags.join(" "));
	}
});
