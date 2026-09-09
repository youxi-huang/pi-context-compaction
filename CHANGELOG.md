# Changelog

This file records changes to Pi Context Compaction. The changelogs under `packages/` retain the upstream Pi package history. Project releases use their own version numbers; the initial host baseline is Pi `v0.85.1`.

Changes under **Unreleased** are not included in an existing release tag or its downloadable assets. Entries describe user-visible behavior, compatibility, security and significant maintenance changes.

## [Unreleased]

### Added

- Local compaction event log. Each compaction attempt, request guard, `context_history` call and `context_note` candidate appends one JSON line to `context-memory-events.jsonl` in the agent directory, recording outcome, error class, durations, token counts, sizes and identifiers. No message text, note content, quotes, queries, file paths or free-form error text is written. Every session has a fixed quota per event kind and the file rotates once at 8 MB. `pi-context-memory.json` accepts `"eventLog": false` to disable it; `/compaction-status` shows the log path and the last write error. `node scripts/context-memory-report.mjs` summarizes the log. Compaction behavior is unchanged.

### Maintenance

- Disabled Dependabot version-update pull requests for npm manifests. The three open version bumps could not pass `verify`: a lockfile out of sync in an example directory, a Biome release that changes the configuration schema and formatting of upstream files, and a `highlight.js` major release that removes the import path the host uses. Each would also widen the diff against the Pi `v0.85.1` baseline, which this project reduces only through reviewed host ports. Dependabot security updates and grouped GitHub Actions version updates remain enabled.

## [v0.1.1] — 2026-09-08

Maintenance release on the same Pi `v0.85.1` baseline. It carries the project rename, the reviewed security fixes, CI and dependency maintenance, and a compaction-handler compatibility fix. Still an experimental source distribution; see the validation record for what remains unproven.

### Changed

- Extensions that only observe `session_before_compact` and return `undefined` no longer trigger `CONTEXT_COMPACTOR_CONFLICT`. They run before the resident compactor and its writer call. A non-resident handler that returns a compaction or a cancellation still fails the compaction with the same error, now raised at the point the result is returned rather than at startup, so a competing compactor is rejected before the writer spends a request. Previously any handler registered for the event was treated as a competing compactor, which blocked startup when unrelated extensions used the event as a signal.
- Renamed the public project from Pi Context Memory to Pi Context Compaction and the repository to `pi-context-compaction`, clarifying its focus on task continuity during context compaction.
- Retained the `pi-context-memory.json` configuration file, `contextMemory` integration API, tool names, checkpoint identifiers and `context-memory` source paths. The rename does not require configuration or session migration.

### Security

- Removed quadratic regular-expression backtracking in skill-path handling, prompt-template defaults, npm package-spec parsing, diff-line parsing and LaTeX script formatting. Pathological input no longer causes the reproduced growth in processing time.
- Changed provider URL detection to match parsed HTTP(S) hostnames. Domain-like text in paths, user information or lookalike hostname suffixes no longer selects provider compatibility behavior or OpenAI-specific cache parameters. Explicit provider and compatibility settings remain supported.
- Added Git option boundaries for package clone and fetch operations. Git package references beginning with `-` or containing NUL are rejected before execution.
- Updated the sandbox example's locked `shell-quote` dependency from `1.8.3` to `1.10.0` and the Gondolin example's locked `undici` dependency from `6.26.0` to `6.28.1`, covering the nine dependency advisories reported for those lockfiles. Also updated a transitive `undici` entry in the root lockfile from `6.28.0` to `6.28.1`; the direct `undici` dependency remains `8.9.0`.

### Maintenance

- Added `node scripts/security-regression-check.mjs` to the existing CI workflow. Its 429 focused tests cover affected host behavior and existing OAuth HTML escaping and message-frame index validation, alongside the separate 18 context-compaction regressions.
- Added weekly Dependabot version checks for npm and GitHub Actions. npm minor and patch updates are grouped by production or development dependency, with a seven-day version cooldown and a limit of three version PRs. Pi host packages remain tied to the reviewed source baseline. Updates require review and are not automatically merged.

Implementation: [87b5d68](https://github.com/youxi-huang/pi-context-compaction/commit/87b5d688d113acafd522676aeaeb4453ae5c23a2) and [PR #6](https://github.com/youxi-huang/pi-context-compaction/pull/6). The offline build and focused checks passed in [Linux CI](https://github.com/youxi-huang/pi-context-compaction/actions/runs/34193631511) and on the merged observer fix. See the [validation record](docs/context-memory/validation.md) for coverage and limits.

## [v0.1.0-alpha.1] — 2026-09-07

Initial experimental source release, published as Pi Context Memory and based on Pi `v0.85.1`. Includes the host changes required by the compaction extension; it is not a drop-in extension for an unmodified Pi installation.

### Added

- A resident compaction extension that survives ordinary extension filtering and reload, with a configurable fixed writer and explicit handling of competing compactors.
- Structured context notes derived from original session records, with validated source references and exact quotations. Boundary compaction works even when the task model does not call `context_note`.
- Branch-scoped history search and paginated reads through `context_history`, including revocable parent-history grants for child-session hosts.
- Persistent-session writer leases, storage-before-publication ordering, stale-source checks and rollback handling. Failed compaction blocks the next provider request until recovery or new input.
- `/compaction-status`, a restart-latched fallback to Pi's default compactor and an explicit-copy migration workflow for complete original histories.
- Reproducible source-build helpers, pinned model data and 18 focused context-compaction regressions, verified in [release CI](https://github.com/youxi-huang/pi-context-compaction/actions/runs/34186515327).

### Compatibility and limits

- Persistent sessions support macOS and Linux; Windows persistence and network-filesystem locking are unsupported.
- Migration requires complete original records. It does not decrypt opaque remote checkpoints, reconstruct missing evidence or modify existing sessions automatically.
- Locally adapted BTW, subagent and provider packages are not bundled. Integrators must check compatibility with the exported host API.
- Long-running semantic quality and repeated incremental-note comparisons remain unvalidated. Source-reference checks do not establish semantic completeness.

Source commit: [ffbeccd](https://github.com/youxi-huang/pi-context-compaction/commit/ffbeccd0bd427058d2c62c0af5743cea9363bdc8). Distributed under the MIT license.

[Unreleased]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.1.1...main
[v0.1.1]: https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.1.1
[v0.1.1 changes]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.1.0-alpha.1...v0.1.1
[v0.1.0-alpha.1]: https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.1.0-alpha.1
