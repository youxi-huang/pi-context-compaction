import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = resolve(root, "node_modules/vitest/dist/cli.js");
const checks = [
	["packages/ai", [vitest, "--run",
		"test/security-boundaries.test.ts", "test/assistant-message-frame.test.ts",
		"test/openrouter-oauth.test.ts", "test/openai-completions-prompt-cache.test.ts"]],
	["packages/coding-agent", [vitest, "--run",
		"test/security-inputs.test.ts", "test/package-manager-security.test.ts",
		"test/package-manager.test.ts", "test/package-manager-ssh.test.ts", "test/prompt-templates.test.ts"]],
	["packages/agent", [vitest, "--run", "test/harness/skills.test.ts"]],
	["packages/tui", ["--test", "test/latex.test.ts"]],
];

for (const [directory, args] of checks) {
	const result = spawnSync(process.execPath, args, {
		cwd: resolve(root, directory),
		stdio: "inherit",
		env: { ...process.env, PI_OFFLINE: "1" },
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
