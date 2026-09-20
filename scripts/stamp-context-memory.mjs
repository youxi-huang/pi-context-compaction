import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = "ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc";
const source = "packages/coding-agent/src";
const extension = `${source}/extensions/context-memory`;
const files = [
	`${source}/core/agent-session-runtime.ts`,
	`${source}/core/agent-session.ts`,
	`${source}/core/extensions/runner.ts`,
	`${source}/core/sdk.ts`,
	`${source}/core/session-manager.ts`,
	`${source}/index.ts`,
	...readdirSync(resolve(root, extension))
		.filter((name) => name.endsWith(".ts") && name !== "build.ts")
		.map((name) => `${extension}/${name}`),
].sort();
const hash = createHash("sha256").update(upstream).update("\n");
for (const file of files) hash.update(file).update("\0").update(readFileSync(resolve(root, file))).update("\0");
const sourceHash = hash.digest("hex");
const build = `0.86.0-context-memory.0.2.4+src.${sourceHash.slice(0, 16)}`;
writeFileSync(resolve(root, `${extension}/build.ts`), `/** Fingerprint of the published runtime source. */\nexport const CONTEXT_MEMORY_BUILD = ${JSON.stringify(build)};\n`);
mkdirSync(resolve(root, ".artifacts"), { recursive: true });
writeFileSync(resolve(root, ".artifacts/context-memory-build.json"), `${JSON.stringify({ build, upstream, sourceHash, files }, null, 2)}\n`);
console.log(build);
