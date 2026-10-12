import assert from "node:assert/strict";

export function assertFinalMainWorkflows(runs, sourceCommit) {
	for (const path of [".github/workflows/context-memory.yml", "dynamic/github-code-scanning/codeql"]) {
		assert(runs.some((run) => run.head_sha === sourceCommit && run.head_branch === "main"
			&& run.path === path && run.status === "completed" && run.conclusion === "success"
			&& (path !== ".github/workflows/context-memory.yml" || run.event === "push")),
		`Final main workflow has not passed: ${path}`);
	}
}

// The publication workflow copies only this module and the release script, so notes live here.
export function releaseNotes({ repository, branch, tag, packageTag, sourceCommit, build, acceptanceChecks, changes }) {
	return `Pi Context Compaction ${tag} supplies an ordinary extension for **unmodified official Pi 1.1.0**.\n\n`
		+ `Install this release's extension package (a fixed package tag) from your terminal, then restart Pi:\n\n\`\`\`sh\npi install git:github.com/${repository}@${packageTag}\n\`\`\`\n\n`
		+ `Start a new persistent text session and run \`/compaction-doctor\` to check it without calling a model. Source tag \`${tag}\` selects the development monorepo, not the package. To follow later previews instead, install the moving \`${branch}\` branch in place of the tag and update only this package with \`pi update --extension git:github.com/${repository}@${branch}\`. A plain \`pi update\` updates Pi itself.\n\n`
		+ `This pre-release supports manual compaction of completed text turns, source-linked history retrieval and explicit disk-confirmed failure recovery. In the sessions it handles, automatic compaction is cancelled and background cache warming is paused. Sessions it never protected and cannot check, such as ones with native checkpoints, images or another Pi version, are left to Pi without a failure marker. Other checkpoint formats, parent-history grants, attachments, concurrent writers and Windows are outside its verified scope.\n\n`
		+ `Ordinary Agent retries after transient provider failures are supported, including partial-response connection drops. Existing retry-related blocks and text-only context-overflow failures can use explicit /compact recovery when sufficient completed source history exists. Arbitrary context edits and unfinished tool-call omissions remain unsupported.\n\n`
		+ `Validation: this publication run passed ${acceptanceChecks} stock-Pi package and lifecycle checks on official Pi 1.1.0. Focused, security, evaluator and scenario results, with remaining known gaps, are in the validation record. Services are synthetic and loopback only. No real-provider quality, latency or interactive TUI claim is made.\n\n`
		+ `Source commit: ${sourceCommit}. Preview runtime: \`${build}\`. Resident runtime keeps its v0.3.0 fingerprint.\n\n`
		+ `[Usage and recovery](https://github.com/${repository}/blob/${tag}/docs/context-memory/extension-preview.md) · [Validation](https://github.com/${repository}/blob/${tag}/docs/context-memory/validation.md)\n\n`
		+ `### Changes\n${changes}\n`;
}

/**
 * Copyable commands stay unambiguous: the first block installs the fixed package tag alone, no block
 * holds more than one Pi command, and the moving branch never shares a block with the fixed tag.
 */
export function assertReleaseNotes(notes, { repository, packageTag, branch }) {
	const blocks = [...notes.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1].trim());
	assert(blocks.length > 0, "Release notes need a copyable install command");
	assert.equal(blocks[0], `pi install git:github.com/${repository}@${packageTag}`, "The first block must install the fixed package tag alone");
	for (const block of blocks) {
		const commands = block.split("\n").filter((line) => /^pi\s/.test(line.trim()));
		assert(commands.length <= 1, "Each copyable block may hold one Pi command");
		assert(!(block.includes(`@${packageTag}`) && block.includes(`@${branch}`)), "A fixed tag and the moving branch must not share a block");
	}
}
