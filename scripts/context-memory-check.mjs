import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const checks = [
	["node_modules/@biomejs/biome/bin/biome", ["check", "--error-on-warnings", "."]],
	["scripts/check-pinned-deps.mjs", []],
	["scripts/check-runtime-deps.mjs", []],
	["scripts/check-ts-relative-imports.mjs", []],
	["scripts/check-entry-graphs.mjs", []],
	["scripts/generate-coding-agent-shrinkwrap.mjs", ["--check"]],
	["scripts/generate-coding-agent-install-lock.mjs", ["--check"]],
	["node_modules/@typescript/native-preview/bin/tsgo.js", ["--noEmit"]],
];
for (const [file, args] of checks) {
	const result = spawnSync(process.execPath, [resolve(root, file), ...args], { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
const result = spawnSync(process.execPath, [resolve(root, "node_modules/vitest/dist/cli.js"), "--run", "test/context-memory.test.ts"], {
	cwd: resolve(root, "packages/coding-agent"), stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
