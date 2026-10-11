import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertFrozenRuntime } from "./frozen.ts";

describe("resident evaluation runtime remains frozen beside the independent preview", () => {
	let root: string;
	let pin: string;
	function git(...args: string[]): string {
		return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-git-config") },
		});
	}
	function write(file: string, text = "export const fixture = true;\n"): void {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
	}
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-preview-freeze-"));
		git("init", "--quiet", "--initial-branch=main");
		for (const file of [
			"packages/coding-agent/src/core/session-manager.ts",
			"packages/coding-agent/src/extensions/context-memory/notes.ts",
			"packages/ai/src/index.ts",
			"packages/agent/src/index.ts",
		])
			write(file);
		git("add", ".");
		git(
			"-c", "user.name=Preview test", "-c", "user.email=preview@example.invalid",
			"commit", "--quiet", "-m", "Frozen fixture",
		);
		pin = git("rev-parse", "HEAD").trim();
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	it("allows untracked and committed preview-only code without moving the resident pin", () => {
		write("packages/coding-agent/src/extensions/context-memory/preview/extension.ts");
		expect(() => assertFrozenRuntime(root, pin)).not.toThrow();
		git("add", ".");
		git(
			"-c", "user.name=Preview test", "-c", "user.email=preview@example.invalid",
			"commit", "--quiet", "-m", "Independent preview",
		);
		expect(() => assertFrozenRuntime(root, pin)).not.toThrow();
	});
	it.each([
		"packages/coding-agent/src/core/session-manager.ts",
		"packages/coding-agent/src/extensions/context-memory/notes.ts",
		"packages/ai/src/index.ts",
		"packages/agent/src/index.ts",
	])("still rejects changes to evaluated code at %s", (file) => {
		write(file, "export const changed = true;\n");
		expect(() => assertFrozenRuntime(root, pin)).toThrow(/EVAL_FROZEN_INPUT_CHANGED/);
	});
	it.each([
		"packages/coding-agent/src/extensions/context-memory/preview-other.ts",
		"packages/coding-agent/src/extensions/context-memory/new-helper.ts",
		"eval/fixtures/extra.json",
	])("still rejects new runtime or fixture inputs at %s", (file) => {
		write(file);
		expect(() => assertFrozenRuntime(root, pin)).toThrow(/EVAL_FROZEN_INPUT_CHANGED/);
	});
});
