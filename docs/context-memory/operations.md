# Shared operations runbook

Claude Code and Codex use this repository-owned runbook. Read it before routine
maintenance. Work from a checkout with the pinned evaluation commit in history;
CI uses Node 22 and a full clone (`fetch-depth: 0`).

## Entry points

Run `node scripts/context-memory-ops.mjs <command>` from any repository directory
(adjust the path to the script). It uses only Node built-ins and existing commands.

| Command | Existing workflow |
| --- | --- |
| `doctor` | Read-only inventory: user/HOME, Node, Git, evaluation pin, dependencies, official Pi, duplicate names, untracked extension `.ts`, worktree. |
| `deps` | Run `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline` when the lock hash/installation is stale; record the hash in `node_modules/.context-memory-ops-lock`. |
| `build` | deps, duplicate check, model data, stamp, fingerprint gate, `npm run build:offline`. |
| `verify` | build, `context-memory-check.mjs`, `security-regression-check.mjs`. |
| `preview` | build, preview build, Pi 1.1.0, acceptance, Pi 1.0.4, default-settings scenarios, release checks, release `--prepare`. |
| `eval [--full] [--keep]` | build, network-blocked reduced evaluation; `--full` uses `eval/check.mjs`; remove scratch artifacts unless `--keep`. |
| `ci` | build, both acceptance checks, all preview steps, full offline evaluation, in CI order. |

[`.github/workflows/context-memory.yml`](../../.github/workflows/context-memory.yml)
is the sole authority for commands and order. If this script disagrees, follow CI
and report the discrepancy. Preview install/acceptance commands come from
[extension-preview.md](extension-preview.md); evaluation commands come from
[eval/README.md](../../eval/README.md).

All child commands receive `PI_OFFLINE=1`, `EVAL_PROVIDER_MODE=scripted`, and
`EVAL_MODEL_CALL_BUDGET=0`. Stock-Pi acceptance uses its existing isolated loopback
services and synthetic credentials; it is not a real-provider result.
Both preview runners load a copy of the package from a temporary directory
outside any Node project, so its Pi imports reach the official host under test
rather than this repository's workspace build; do not bypass that check.
Both official Pi versions use `context-memory-preview-stock-install.mjs`, which
pins all eight official runtime components to the reviewed version and checks
registry integrity and SDK startup with networking denied. A complete matching
cache skips npm; a mixed or incomplete cache is repaired. Scenarios report listed known gaps; new failures or a listed gap
that starts passing fail the step until the gap becomes a required regression.

Dependency and official Pi installation may download packages. As in CI, build
runs `node scripts/context-memory-model-data.mjs` directly: on a cold cache it
downloads the pinned source archive and verifies SHA-256 before extraction.

Normal output is two lines per step plus the final log-directory location.
Full logs live under `os.tmpdir()`, separated by user uid and invocation.
Use `--verbose` to stream output; `doctor --verbose` shows the inventory.
Doctor reports readiness without installing or requiring a clean checkout.
Duplicate filenames fail immediately. Other failures print the step's exit code,
duration and last 40 log lines. Exit 0 means completion, 1 marks the fingerprint
gate, 2 means invalid usage; a failed command retains its own exit code.

Preview `--prepare` requires a clean committed checkout. It only prepares local
archives and never publishes. Do not bypass its clean-source check.

## Two deliberate gates

Stop maintenance decisions at either gate and wait for the maintainer:

1. After stamp, a diff in
   `packages/coding-agent/src/extensions/context-memory/build.ts` means a
   fingerprinted runtime or host input changed. Checks may finish, but do not
   commit the new fingerprint without explicit approval in this task. The script
   warns, returns 1 after remaining checks, and never commits or restores it.
2. `EVAL_FROZEN_INPUT_CHANGED` means the evaluated input differs from its frozen
   contract. Do not change the pin in `eval/runtime.ts` or alter tests to bypass
   the failure. Report the evidence and wait for the maintainer's decision.

## Routine tasks

- **Unfixed vulnerabilities:** follow [SECURITY.md](../../SECURITY.md) for private
  vulnerability reporting. Stop and notify the maintainer first; until the fix
  is released, do not disclose details in public PRs, issues, commit messages,
  or this runbook.
- **Dependabot security PRs:** npm version-update PRs are disabled; review the
  remaining security updates individually. First establish whether the affected
  package is loaded by this project: sandbox examples do not enter the bundle.
  For examples with their own lockfile, run `npm ci --ignore-scripts` and
  `npm audit` in that directory. Regenerate the coding-agent install lock with
  `scripts/generate-coding-agent-install-lock.mjs`; never hand-edit it. State the
  GHSA identifier and affected scope in CHANGELOG's Security entry.
- **Weekly grouped GitHub Actions updates:** keep actions pinned to commit SHAs;
  do not replace them with tags.
- **Red CI:** reproduce with `ci`, then check whether main fails too. Identify
  and fix the cause; do not retry for luck, skip tests, or disable checks.
- **CodeQL alerts:** assess each alert to decide whether runtime code must change.
  Add needed regressions to `security-regression-check.mjs`. Follow CHANGELOG's
  Security entries for the fixes associated with alerts #43–#46 as writing models.
- **Runtime defects:** write a focused regression that reproduces the defect,
  then fix it. Expect the first deliberate gate.
- **Porting a newer upstream Pi:** submit a plan first, covering all six host
  files, `upstream-delta.md`, the stamp input list, and the model-data pin.

## Never

- Push `v*` tags or `release/publish-v*` branches; they trigger publication.
- Change version strings, build fingerprints, tags, or release assets without
  the maintainer's explicit authorization.
- Run `npm test` or the complete upstream vitest suite.
- Use any credentials to run a real provider, or modify upstream snapshot files.
- Put session logs, note contents, credentials, or identifying local paths in
  the repository, fixtures, issues, or PRs. Keep operational logs local.

## Evidence

Every "verified" claim in a report or PR must name the command, result, and exit
code. Mark omitted checks `not run`. Separate scripted/synthetic evidence from
real-provider evidence; report failures as they occurred. Commit messages use
`type: summary`, with a lowercase start: `build`, `fix`, `feat`, `test`, `docs`,
`security`, `deps`, `eval`, or `scripts`.

## Two agents, one repository

Before starting, inspect open PRs and branches to avoid duplicate work. Use one
branch per task and never rewrite another agent's branch. When the same class of
problem appears for the third time, propose adding its handling to this runbook
in the PR description. To stop mid-task or continue another session's work,
follow the [handoff protocol](handoff-protocol.md). Personal language and
writing preferences belong in each platform's user settings, not here.
