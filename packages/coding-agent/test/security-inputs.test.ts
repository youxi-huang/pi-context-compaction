import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { parseSkillBlock } from "../src/core/agent-session.ts";
import { substituteArgs } from "../src/core/prompt-templates.ts";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("security input regressions", () => {
	it("handles adversarial inputs without repeated suffix scans", () => {
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./fixtures/security-inputs-worker.ts", import.meta.url))],
			{
				encoding: "utf8",
				timeout: 15_000,
				env: { ...process.env, PI_OFFLINE: "1" },
			},
		);
		expect(result.error, result.stderr).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Security input probes passed");
	}, 20_000);

	it.each([
		[`\${1:-fallback} / \${2:-$1}`, ["first"], "first / $1"],
		["${@:-unfinished $1", ["first"], "${@:-unfinished first"],
		[`\${1:-\${2:-nested}} $1`, [], `\${2:-nested} `],
		[`\${1:-\${@:2}} $1`, [], `\${@:2} `],
		[`\${@:0:2} / \${@:2} / $3`, ["a", "b", "c"], "a b / b c / c"],
	] as const)("preserves literal defaults and argument substitution: %s", (template, args, expected) => {
		expect(substituteArgs(template, [...args])).toBe(expected);
	});

	it("keeps diff numbering and unnumbered content intact", () => {
		initTheme("dark");
		for (const line of ["-  12 removed", "+  12 added", "  12 context", "- 123abc", "     ..."]) {
			expect(stripVTControlCharacters(renderDiff(line))).toBe(line);
		}
	});

	it("keeps a skill body separate from the following user message", () => {
		expect(parseSkillBlock('<skill name="s" location="x">\nbody\n</skill>\n\n instruction ')).toEqual({
			name: "s",
			location: "x",
			content: "body",
			userMessage: "instruction",
		});
		expect(parseSkillBlock('<skill name="s" location="x">\nbody\n</skill>garbage')).toBeNull();
	});
});
