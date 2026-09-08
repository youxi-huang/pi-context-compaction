import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { parseGitUrl } from "../src/utils/git.ts";

interface Commands {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
	runCommandCapture(command: string, args: string[]): Promise<string>;
}

describe("git package argument boundaries", () => {
	let directory: string;
	let manager: DefaultPackageManager;
	let commands: Commands;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-git-security-"));
		manager = new DefaultPackageManager({
			cwd: directory,
			agentDir: join(directory, "agent"),
			settingsManager: SettingsManager.inMemory(),
		});
		commands = manager as unknown as Commands;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true, force: true });
	});

	// CodeQL #30–33: repository names and refs must never become git command options.
	it.each([
		"https://github.com/example/repo@--upload-pack=unexpected-command",
		"git:git@github.com:example/repo@--upload-pack=unexpected-command",
		"https://github.com/example/repo#--upload-pack=unexpected-command",
	])("rejects an option-shaped ref before starting a process: %s", async (source) => {
		const run = vi.spyOn(commands, "runCommand").mockResolvedValue();
		expect(parseGitUrl(source)).toBeNull();
		await expect(manager.install(source)).rejects.toThrow("Path does not exist");
		expect(run).not.toHaveBeenCalled();
	});

	it("separates clone and fetch operands while retaining a normal pinned ref", async () => {
		const run = vi.spyOn(commands, "runCommand").mockImplementation(async (command, args) => {
			if (command === "git" && args[0] === "clone") mkdirSync(args.at(-1)!, { recursive: true });
		});
		vi.spyOn(commands, "runCommandCapture").mockResolvedValue("abc123");
		await manager.install("https://github.com/example/repo@release/test");
		expect(run).toHaveBeenCalledWith("git", ["clone", "--", "https://github.com/example/repo", expect.any(String)]);
		expect(run).toHaveBeenCalledWith("git", ["checkout", "release/test"], expect.any(Object));
		run.mockClear();
		await manager.install("https://github.com/example/repo@release/test");
		expect(run).toHaveBeenCalledWith("git", ["fetch", "--", "origin", "release/test"], expect.any(Object));
	});
});
