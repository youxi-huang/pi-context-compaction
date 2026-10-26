import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const args of [
	["node_modules/vitest/dist/cli.js", "run", "packages/compaction-dsh/test", "packages/compaction-opencode/test"],
	["scripts/context-memory-adapters-build.mjs"],
]) {
	const result = spawnSync(process.execPath, args, {
		cwd: root, stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1", EVAL_PROVIDER_MODE: "scripted", EVAL_MODEL_CALL_BUDGET: "0" },
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
