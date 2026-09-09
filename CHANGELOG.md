# Changelog

This file records changes to Pi Context Compaction. The changelogs under `packages/` retain the upstream Pi package history. Project releases use their own version numbers; the initial host baseline is Pi `v0.85.1`.

Changes under **Unreleased** are not included in an existing release tag or its downloadable assets. Entries describe user-visible behavior, compatibility, security and significant maintenance changes.

## [Unreleased]

### Maintenance

- Added `docs/context-memory/roadmap.md`: version policy, the four measurements, planned minor releases and the external baseline. Linked from the README.
- Replaced the inherited upstream `AGENTS.md` with project-level agent instructions. The upstream file is retained as `UPSTREAM_AGENTS.md`. Previously an automated agent reading the repository root would have followed upstream Pi's release, test and changelog rules, which do not apply here.
- Added `docs/context-memory/upstream-delta.md`: the upstream baseline, what is new, and the seven host source files with the reason each one is changed. `THIRD_PARTY_NOTICES.md` previously counted six; the one-line `findCutPoint` change in `core/compaction/compaction.ts` from v0.2.0 is the seventh.
- The README now opens with the project's identity (experimental distribution, not a Pi package), the problem it addresses, the intended end state and what has actually been verified. No behavior described elsewhere in the README changed.
- Corrected the host security regression count in `docs/context-memory/validation.md` from 429 to 111, which is what `scripts/security-regression-check.mjs` reports. The v0.2.0 release notes already said 111.

## [v0.2.0] — 2026-09-09

Low-friction compaction on the same Pi `v0.85.1` baseline, still an experimental source distribution and marked as a pre-release on GitHub. The session model writes its own handover note, nothing is kept after a checkpoint by default, a local event log records every attempt, and the first real two-checkpoint session drove three follow-up changes. See the validation record for what remains unproven.

### Changed

- The default writer is now the session model itself (`"writerModel": "session"`). The compaction request is the session's own provider context plus one closing handover instruction, so no second model or additional authentication is needed and the provider's prompt cache can serve the request. A fixed `provider/model` writer remains available and behaves as before. Sessions that previously relied on the implicit `openai-codex/gpt-6-astra` default must now name it in `pi-context-memory.json` to keep using it. Neither writer falls back to the other; failure still blocks the next request.
- After a checkpoint, model context keeps no original messages by default. The next request holds the system prompt, the note and the new input; original records stay in the session file and on screen and remain retrievable with `context_history`. An unfinished or retried turn keeps its own user message and tool rounds. Previously about 20,000 tokens of recent originals were kept, and sessions below that size could not be compacted.
- Manual `/compact` now works on any session with at least one complete turn, including short conversations.
- The default note budget is 3,000 estimated tokens (previously 6,000), still capped at 15% of the compaction threshold.
- Reasoning effort is passed to the writer only when the model declares reasoning support, matching Pi's own summarizer.
- `/compaction-status` reports the resolved writer, or the error class explaining why it cannot run. A fixed writer that is missing from the catalog or whose provider has no configured authentication is reported at session start, as a terminal notification or on stderr.
- Pi's `findCutPoint` falls back to the latest cut point instead of the first when the keep budget is met inside the trailing entries of the last turn. Previously a branch ending in a tool result could not prepare a compaction with a small keep budget.
- `scripts/context-memory-migrate.mjs --prepare` stops with a directed message when the writer is `session`, since the script has no live session; name a fixed writer for the run.
- Compaction events and checkpoints record the writer that actually ran (`provider/model`), not the configuration string.
- The `session` writer now reasons at the session's current thinking level, the way Pi's own summarizer does, instead of the configured `writerEffort`; `writerEffort` applies to a fixed writer only. A session with thinking off writes without reasoning. Compaction events record the effort actually sent as `writerEffort`. In a real two-checkpoint session on 2026-09-09 the session ran at `high` while both writer requests carried the configured `medium`; the two settings are now the same setting.
- `context_history` search ranks matched entries by number of matched terms, then conversation turns (user, then assistant) above tool output, then newest first. Previously ties kept conversation order, so a single-word query opened with the earliest and usually longest tool result on the branch and filled the page with it. Results are therefore no longer chronological; each excerpt now carries `position`, its index on the branch, and the tool description says so. Cursors from earlier builds are rejected with `HISTORY_CURSOR_INVALID` because the ranking version is part of the cursor signature.

### Added

- After a second checkpoint on a branch, the rendered note carries a `priorCheckpoints` section: the most recent earlier checkpoints (about three within a 600-token bound), oldest first, each as the nearest readable original at or before its `coveredThrough` plus the opening sentence of up to three state items, bounded by estimated tokens so Chinese and English cost the same share. When the bound is exceeded, middle checkpoints are dropped first and the newest last, so the oldest phase survives longest; the section also shrinks before a checkpoint would be refused for size. The host assembles it from stored checkpoints; the writer's JSON note and budget are unchanged, and the section states that its IDs are search anchors, not citable sources. Compaction events record its size as `lineageTokens`, separate from `noteTokens`. This keeps an earlier phase locatable through `context_history` when the newest note no longer mentions it: in a two-checkpoint session on 2026-09-09 the second note lost every conclusion and every entry-ID anchor from the first phase, keeping only a file read location.

- `pi-context-memory.json` accepts `keepRecentTokens` (default `0`), `noteTokens` (default `3000`, minimum `500`) and `compactAt` (an integer token count above 1 or a window share at or below 1; unset by default). Malformed values fail with `CONTEXT_CONFIG` at startup; a `compactAt` too small for the selected model fails with `CONTEXT_CAPACITY` when that model is selected.
- Local compaction event log. Each compaction attempt, request guard, `context_history` call and `context_note` candidate appends one JSON line to `context-memory-events.jsonl` in the agent directory, recording outcome, error class, durations, token counts, sizes and identifiers. No message text, note content, quotes, queries, file paths or free-form error text is written. Every session has a fixed quota per event kind; at 8 MB the file is renamed to `.1`, replacing the previous generation. `pi-context-memory.json` accepts `"eventLog": false` to disable it, and `"enabled": false` disables it as well; `/compaction-status` shows the log path and the last write error. `node scripts/context-memory-report.mjs` summarizes the log. Compaction behavior is unchanged.

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

[Unreleased]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.2.0...main
[v0.2.0]: https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.2.0
[v0.2.0 changes]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.1.1...v0.2.0
[v0.1.1]: https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.1.1
[v0.1.1 changes]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.1.0-alpha.1...v0.1.1
[v0.1.0-alpha.1]: https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.1.0-alpha.1
