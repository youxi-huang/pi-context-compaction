import assert from "node:assert/strict";
import { formatSkillInvocation } from "../../../agent/src/harness/skills.ts";
import { renderLatex } from "../../../tui/src/latex.ts";
import { parseSkillBlock } from "../../src/core/agent-session.ts";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
import { substituteArgs } from "../../src/core/prompt-templates.ts";
import { renderDiff } from "../../src/modes/interactive/components/diff.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

// Run in a killable child: a synchronous regex regression must not hang the test runner.
const count = 80_000;
const path = `${"/".repeat(count)}x`;
const invocation = formatSkillInvocation({ name: "s", description: "s", filePath: path, content: "body" });
assert.ok(invocation.includes(`References are relative to ${"/".repeat(count - 1)}.`));

const unfinished = `\${@:-${"${0:-|".repeat(count)}`;
assert.equal(substituteArgs(`${unfinished} $1`, ["argument"]), `${unfinished} argument`);

const npmSpec = `${"?/".repeat(count)}@`;
const parser = DefaultPackageManager.prototype as unknown as {
	parseNpmSpec(spec: string): { name: string; version?: string };
};
assert.deepEqual(parser.parseNpmSpec(npmSpec), { name: npmSpec });

initTheme("dark");
const malformedDiff = `-${"\t".repeat(count)}x\u2028x`;
assert.ok(renderDiff(malformedDiff).includes(malformedDiff));

assert.equal(renderLatex(`x^{a${"\\quad ".repeat(count)}b}`), "x^(a b)");

// CodeQL #2: the first valid closing marker consumes the remaining user message in one pass.
const userMessage = "\n</skill>\n\na".repeat(count);
assert.deepEqual(parseSkillBlock(`<skill name="s" location="x">\nbody\n</skill>\n\n${userMessage}`), {
	name: "s",
	location: "x",
	content: "body",
	userMessage: userMessage.trim(),
});
console.log("Security input probes passed");
