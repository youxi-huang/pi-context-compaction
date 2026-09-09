# Agent instructions for this repository

This repository is Pi Context Compaction, an experimental distribution of [Pi](https://github.com/earendil-works/pi) built from source. It is based on upstream Pi `v0.85.1` (commit `d981de1229ef899957bbe968bc8dcda02a21f477`) and adds a context-compaction extension plus a small number of host changes. It is not the Pi monorepo and it is not a Pi package. Upstream release, publishing, labeling and changelog rules do not apply here.

The upstream development rules are kept for reference in [UPSTREAM_AGENTS.md](UPSTREAM_AGENTS.md). Their code-quality rules for TypeScript still hold in this repository: no `any`, top-level imports only, erasable TypeScript syntax only, no hardcoded key checks. Their commands, release process and issue conventions do not apply. Where this file and [CONTRIBUTING.md](CONTRIBUTING.md) say something different from the upstream file, this file wins.

## What belongs to this project

| Location | Contents |
| --- | --- |
| `packages/coding-agent/src/extensions/context-memory/` | The compaction runtime: writer, notes, storage, leases, history retrieval, grants, events, policy. |
| `packages/coding-agent/test/context-memory.test.ts` and `test/fixtures/context-memory-*` | The focused regressions for the runtime. |
| `scripts/context-memory-*.mjs`, `scripts/stamp-context-memory.mjs`, `scripts/security-regression-check.mjs` | Build stamping, model data, checks, migration and the event-log report. |
| `docs/context-memory/` | Architecture, validation record, roadmap and the upstream delta. |
| Seven host source files | Listed with reasons in [docs/context-memory/upstream-delta.md](docs/context-memory/upstream-delta.md). |
| `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `.github/` | Project documentation and CI. |

Everything else is unchanged upstream Pi code, imported as a snapshot without upstream history. Do not refactor, reformat or "clean up" upstream files. A task that seems to need a change outside the locations above is a host change and follows the rule below.

## Build and verify

```sh
npm ci --ignore-scripts
node scripts/context-memory-model-data.mjs
node scripts/stamp-context-memory.mjs
npm run build:offline
node scripts/context-memory-check.mjs
node scripts/security-regression-check.mjs
```

The last two commands are the acceptance bar and are what CI runs. `context-memory-check.mjs` runs static checks and the context-memory regressions without calling a model. `security-regression-check.mjs` runs the host security regressions with synthetic input. Neither needs provider credentials.

Do not run the full upstream vitest suite or `npm test`; they include end-to-end tests that activate when provider credentials are present. Do not run live provider tests with credentials that are not yours. Simulated results and provider runs are reported as different things.

Before stamping, make sure there are no stray duplicate files (for example `events 2.ts`) in the extension directory or `scripts/`. The stamp reads every `.ts` file in the extension directory, so an untracked duplicate makes the local fingerprint differ from CI and `verify` fails.

## Making changes

- Keep memory policy inside the extension directory. A change to a host file must state why the extension layer cannot enforce the behavior itself, must be added to `docs/context-memory/upstream-delta.md`, and must be added to the file list in `scripts/stamp-context-memory.mjs` so the build fingerprint covers it.
- Add focused regressions for any change to persistence, authorization, compaction lifecycle or the event log.
- Do not add a second history database. Do not substitute a writer on failure. A failed compaction blocks the next request by design.
- Record user-visible changes under **Unreleased** in the root `CHANGELOG.md`, grouped as Added, Changed, Fixed, Security or Maintenance. The changelogs under `packages/` are upstream history and are not edited.
- Do not change version strings, build fingerprints, tags or release assets. Releases are made by the maintainer. The root `package.json` carries upstream workspace metadata and is not this project's version.
- Do not commit, push, open pull requests or create releases unless asked.
- Do not add credentials, session logs, note content or local file paths to the repository, to fixtures or to issue text.

## Where to look

| Symptom or task | Start with |
| --- | --- |
| Resident extension missing, `/reload` or SDK loading | `loader.ts`, `extension.ts`, `policy.ts`; host `core/sdk.ts`, `core/agent-session-runtime.ts` |
| Requests continue after a failed compaction, changed sources, lost notes | `controller.ts`, `writer.ts`, `notes.ts`; host `core/extensions/runner.ts`, `core/agent-session.ts` |
| Session lock, first flush, fork or write failures | `lease.ts`, `storage.ts`; host `core/session-manager.ts` |
| History out of scope, pagination, parent grants, revocation | `history.ts`, `grant-file.ts`, `test/fixtures/context-memory-*-worker.ts` |
| Compactor conflicts, handler ordering | `policy.ts` (`orderCompactionExtensions`, `assertCompactionResult`); host `core/extensions/runner.ts` |
| Missing event lines, wrong error class, quotas, rotation | `events.ts`; `controller.ts` (`settle`, `guarded`, `compactionFailed`); `scripts/context-memory-report.mjs` |
| Build identity, model baseline, release version | `scripts/stamp-context-memory.mjs`, `scripts/context-memory-model-data.mjs`, `.github/workflows/context-memory.yml` |
