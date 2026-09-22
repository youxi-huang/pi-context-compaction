import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_PIN } from "../schema.ts";

export const FIXTURE_REVISION = "87f707e9d06da0a9eaac4854a91423ef1c04cf1f";
export const FIXTURE_CONTENT_HASH = "6d19b38a2788a0610ebfc1996a0578437c83ec361f3cd6807ed9a37848b0cbb8";
const fixtureFiles = [
	"eval/fixtures/F1/gold.json",
	"eval/fixtures/F1/session.jsonl",
	"eval/fixtures/F2/gold.json",
	"eval/fixtures/F2/session.jsonl",
	"eval/fixtures/F3/gold.json",
	"eval/fixtures/F3/session.jsonl",
	"eval/fixtures/fixture.schema.json",
	"eval/fixtures/manifest.json",
	"eval/fixtures/preflight.json",
	"eval/fixtures/response.schema.json",
	"eval/schema.ts",
	"eval/scorer.ts",
	"eval/task-environment.ts",
];

export function runnerFingerprint(): string {
	const root = fileURLToPath(new URL("./", import.meta.url));
	const hash = createHash("sha256");
	for (const directory of [root, join(root, "../live")]) {
		for (const file of readdirSync(directory)
			.filter((name) => name.endsWith(".ts"))
			.sort())
			hash
				.update(directory === root ? "runner/" : "live/")
				.update(file)
				.update("\0")
				.update(readFileSync(join(directory, file)))
				.update("\0");
	}
	return hash.digest("hex");
}
export function assertFrozenInputs(): void {
	const cwd = fileURLToPath(new URL("../../", import.meta.url));
	const runtimeFiles = ["packages/coding-agent/src", "packages/ai/src", "packages/agent/src"];
	const diff = execFileSync("git", ["diff", RUNTIME_PIN, "--", ...runtimeFiles], { cwd, encoding: "utf8" });
	const untracked = execFileSync(
		"git",
		["ls-files", "--others", "--exclude-standard", "--", ...runtimeFiles, "eval/fixtures"],
		{ cwd, encoding: "utf8" },
	);
	if (diff || untracked) throw new Error(`EVAL_FROZEN_INPUT_CHANGED:${RUNTIME_PIN}`);
	// Content lock survives a later squash merge of the accepted implementation commits.
	const currentFiles = execFileSync(
		"git",
		["ls-files", "--", "eval/fixtures", "eval/schema.ts", "eval/scorer.ts", "eval/task-environment.ts"],
		{ cwd, encoding: "utf8" },
	)
		.trim()
		.split("\n")
		.sort();
	if (JSON.stringify(currentFiles) !== JSON.stringify(fixtureFiles)) throw new Error("EVAL_FROZEN_FILE_SET_CHANGED");
	const hash = createHash("sha256");
	for (const file of fixtureFiles)
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(join(cwd, file)))
			.update("\0");
	if (hash.digest("hex") !== FIXTURE_CONTENT_HASH) throw new Error(`EVAL_FROZEN_INPUT_CHANGED:${FIXTURE_REVISION}`);
}
