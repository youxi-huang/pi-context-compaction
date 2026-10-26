import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SUPPORTED_PI_VERSIONS } from "../packages/coding-agent/src/extensions/context-memory/preview/compatibility.ts";
import { inspectOfficialPi } from "./context-memory-preview-stock-install.mjs";

// Like stock-install.test.mjs, this is isolated synthetic evidence, not stock-Pi acceptance.
// The worker uses the real package manager, config reader and preview checkpoint guards.
test("repository-source migration: local Git transport, no network or model calls", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-source-migration-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const deny = fileURLToPath(new URL("../eval/deny-network.mjs", import.meta.url));
	const guard = join(root, "deny-network.mjs");
	// Re-arm the same network guard in npm children even while Pi's update gate is enabled.
	writeFileSync(guard, `process.env.PI_OFFLINE = "1";\nawait import(${JSON.stringify(pathToFileURL(deny).href)});\n`);
	const worker = fileURLToPath(new URL("./context-memory-preview-source-migration-worker.mjs", import.meta.url));
	let stockSdk;
	if (process.env.CONTEXT_MEMORY_MIGRATION_STOCK_ROOT) {
		const stockRoot = resolve(process.env.CONTEXT_MEMORY_MIGRATION_STOCK_ROOT);
		const stockPackage = join(stockRoot, "node_modules/@earendil-works/pi-coding-agent");
		const version = JSON.parse(readFileSync(join(stockPackage, "package.json"), "utf8")).version;
		assert(SUPPORTED_PI_VERSIONS.includes(version), "Migration host must be supported by the candidate");
		inspectOfficialPi(stockRoot, version); // No synthetic/mixed/symlinked host accepted on this route.
		stockSdk = join(stockPackage, "dist/index.js");
		t.diagnostic(`Official Pi ${version} package-manager/settings APIs; local transport and synthetic sessions only.`);
	} else {
		t.diagnostic("Repository package-manager/settings source; local transport and synthetic sessions only.");
	}
	// Do not inherit provider credentials, npm configuration, Git rewrites or a user's agent directory.
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		LANG: "C.UTF-8", CI: "1",
		PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
		PI_CODING_AGENT_DIR: join(root, "unused-agent"),
		EVAL_PROVIDER_MODE: "scripted", EVAL_MODEL_CALL_BUDGET: "0",
		...(stockSdk ? { CONTEXT_MEMORY_MIGRATION_STOCK_SDK: stockSdk } : {}),
		// Inherited by npm as well as the worker. Git is separately restricted to file transport.
		NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
		GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0",
		npm_config_userconfig: join(root, "npmrc"), npm_config_globalconfig: join(root, "global-npmrc"),
		npm_config_cache: join(root, "npm-cache"), npm_config_offline: "true",
		npm_config_audit: "false", npm_config_fund: "false", npm_config_ignore_scripts: "true",
	};
	const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", worker], {
		cwd: root, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /# tests [1-9][0-9]*/);
	assert.match(result.stdout, /# fail 0/);
	t.diagnostic(result.stdout.split("\n").filter((line) => /^(?:ok |not ok |# (?:tests|pass|fail|skipped))/.test(line)).join("\n"));
});
