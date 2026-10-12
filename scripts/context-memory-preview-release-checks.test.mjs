import assert from "node:assert/strict";
import test from "node:test";
import { assertFinalMainWorkflows, assertReleaseNotes, releaseNotes } from "./context-memory-preview-release-checks.mjs";

const sourceCommit = "534c8994ed17539ac97ed5712c36efe01268dffb";
// GitHub's default CodeQL setup reports event=dynamic, including scans of main.
const mainRuns = [
	{ head_sha: sourceCommit, head_branch: "main", path: ".github/workflows/context-memory.yml", event: "push", status: "completed", conclusion: "success" },
	{ head_sha: sourceCommit, head_branch: "main", path: "dynamic/github-code-scanning/codeql", event: "dynamic", status: "completed", conclusion: "success" },
];

test("completed default CodeQL and push verification both satisfy the release gate", () => {
	assert.doesNotThrow(() => assertFinalMainWorkflows(mainRuns, sourceCommit));
});

test("a scan of another source commit, tag or workflow cannot replace the main scan", () => {
	for (const replacement of [{ head_sha: "0".repeat(40) }, { head_branch: "v0.3.1" }, { path: ".github/workflows/another.yml" }]) {
		assert.throws(() => assertFinalMainWorkflows([mainRuns[0], { ...mainRuns[1], ...replacement }], sourceCommit));
	}
});

test("a missing, failed or unfinished main workflow blocks publication", () => {
	for (const index of [0, 1]) {
		assert.throws(() => assertFinalMainWorkflows(mainRuns.filter((_, i) => i !== index), sourceCommit));
		for (const replacement of [{ status: "in_progress", conclusion: null }, { conclusion: "failure" }]) {
			assert.throws(() => assertFinalMainWorkflows(mainRuns.map((run, i) => i === index ? { ...run, ...replacement } : run), sourceCommit));
		}
	}
});

test("manual verification cannot replace the final main push verification", () => {
	assert.throws(() => assertFinalMainWorkflows([{ ...mainRuns[0], event: "workflow_dispatch" }, mainRuns[1]], sourceCommit));
});

const repository = "youxi-huang/pi-context-compaction";
const noteOptions = { repository, packageTag: "extension-v0.3.3", branch: "extension-preview" };
const notes = releaseNotes({ ...noteOptions, tag: "v0.3.3", sourceCommit, build: "stock-preview+src.0000000000000000", acceptanceChecks: 27, changes: "### Fixed\n\n- Synthetic entry." });

test("generated release notes install the fixed package tag alone in their first block", () => {
	assert.doesNotThrow(() => assertReleaseNotes(notes, noteOptions));
	assert.match(notes, /```sh\npi install git:github\.com\/youxi-huang\/pi-context-compaction@extension-v0\.3\.3\n```/);
	assert.doesNotMatch(notes, /147 context checks|83 scenario checks/);
});

test("install, update and remove commands may not share a copyable block", () => {
	const combined = "```sh\npi install git:github.com/youxi-huang/pi-context-compaction@extension-v0.3.3\npi update --extension git:github.com/youxi-huang/pi-context-compaction@extension-preview\n```\n";
	assert.throws(() => assertReleaseNotes(combined, noteOptions));
});

test("the first copyable block may not install the moving branch", () => {
	const moving = "```sh\npi install git:github.com/youxi-huang/pi-context-compaction@extension-preview\n```\n";
	assert.throws(() => assertReleaseNotes(moving, noteOptions));
});
