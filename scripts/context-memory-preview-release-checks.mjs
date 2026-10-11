import assert from "node:assert/strict";

export function assertFinalMainWorkflows(runs, sourceCommit) {
	for (const path of [".github/workflows/context-memory.yml", "dynamic/github-code-scanning/codeql"]) {
		assert(runs.some((run) => run.head_sha === sourceCommit && run.head_branch === "main"
			&& run.path === path && run.status === "completed" && run.conclusion === "success"
			&& (path !== ".github/workflows/context-memory.yml" || run.event === "push")),
		`Final main workflow has not passed: ${path}`);
	}
}
