import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PI_OFFLINE !== "1" || process.env.EVAL_MODEL_CALL_BUDGET !== "0" || process.env.EVAL_PROVIDER_MODE !== "scripted") throw new Error("EVAL_OFFLINE_CONFIGURATION_REQUIRED");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.EVAL_ARTIFACT_DIR;
if (!output || !isAbsolute(output)) throw new Error("EVAL_ARTIFACT_DIR must be absolute");
mkdirSync(output, { recursive: true });
const env = { ...process.env, STAGE0_ARTIFACT_DIR: output, NODE_OPTIONS: `--import=${JSON.stringify(resolve(root, "eval/deny-network.mjs"))}` };
for (const args of [
	["node_modules/@typescript/native-preview/bin/tsgo.js", "--noEmit", "-p", "eval/tsconfig.json"],
	["--experimental-strip-types", "eval/generate-fixtures.ts", "--check"],
	["node_modules/vitest/dist/cli.js", "run", "--config", "packages/coding-agent/vitest.config.ts", "eval/fixture.test.ts", "eval/scorer.test.ts", "eval/report.test.ts", "eval/pi/preflight.test.ts", "eval/pi/structure.test.ts", "eval/stage0/interface-gate.test.ts"],
]) {
	const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
