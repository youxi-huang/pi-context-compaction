# Delta from upstream Pi

This repository is a snapshot of upstream Pi plus one new extension directory, a set of project scripts and tests, and a small number of edits to host source files. This page lists exactly what differs, so a reader or a tool can tell project code from inherited code without diffing the whole tree.

| Item | Value |
| --- | --- |
| Upstream baseline | Pi `v0.86.0`, commit `ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc`, imported as a clean snapshot without upstream history |
| New implementation | `packages/coding-agent/src/extensions/context-memory/` |
| Project tests | `packages/coding-agent/test/context-memory.test.ts`, `packages/coding-agent/test/fixtures/context-memory-*` |
| Project scripts | `scripts/context-memory-*.mjs`, `scripts/stamp-context-memory.mjs`, `scripts/security-regression-check.mjs` |
| Project documentation and CI | `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `AGENTS.md`, `docs/context-memory/`, `.github/` |
| Host source files changed | Six, listed below |
| Everything else | Upstream Pi code plus previously reviewed dependency/security hardening retained by this distribution |

The upstream `README.md`, `CONTRIBUTING.md` and `AGENTS.md` are kept as `UPSTREAM_README.md`, `UPSTREAM_CONTRIBUTING.md` and `UPSTREAM_AGENTS.md`. They describe upstream Pi, not this distribution.

## Why the host is changed at all

Pi's extension API runs handlers on events. For most of what this project does, that is enough: the writer, the note format, history search, grants and the event log all live in the extension. Five things cannot be enforced from an event handler, because the handler runs after the moment that matters, or can be filtered out before it runs, or is not consulted at all:

1. An extension can be removed by ordinary extension filtering (`--no-extensions`, settings) or dropped on `/reload`. A compaction guarantee that disappears when the extension is filtered is not a guarantee.
2. Session writes reach Pi's in-memory tree before any extension sees them. Disk-before-memory publication and cooperative leases need a hook inside the session manager.
3. When a resident handler reports that compaction failed, the extension runner must propagate that failure so the next provider request is blocked, instead of logging it and continuing.
4. Pi v0.86.0 now fixes the former zero-keep-budget cut-point issue upstream; this distribution no longer changes that file.
5. A retained tool turn can span older checkpoints. The session manager must omit those old compaction entries when assembling the kept prefix, or their full summaries reappear alongside the newest summary. A `context` event alone cannot fix SDK context assembly and compaction preparation, which also consume the session manager's output.

The [roadmap](roadmap.md) commits to a public stock-Pi extension before 1.0, with implementation starting in the 0.3 period. Reviewing these dependencies against public APIs in a pinned upstream release is the first step toward that delivery, followed by migration, verification and packaging. The preview must work without host patches for its declared workflows; broader compatibility and maturity work can follow before 1.0. This list describes the current implementation, not proof that every choice must remain a host patch or an obligation to reproduce every resident-build guarantee in the first preview. Scope differences must be explicit. Host footprint, counted in lines changed against upstream, is one of the project's four measurements.

## The six host files

All paths are under `packages/coding-agent/src/`.

| File | What changed | Why the extension layer cannot do it |
| --- | --- | --- |
| `core/sdk.ts` | The resource loader is wrapped with `withContextMemory` when a session is created, so the compaction extension is loaded as a resident. | Ordinary extension discovery and filtering run before any extension code executes. The resident has to be attached at loader construction. |
| `core/agent-session-runtime.ts` | Branching and forking go through `sessionManager.forkBranch`, so the destination acquires a lease before writable state is exposed. | The fork path creates the new session manager before any session event fires. |
| `core/agent-session.ts` | On construction the session asserts that the resident extension and its tools are present and claims the session for the memory subsystem; on dispose it releases the claim. The saved compaction entry is read from the session leaf. | Ownership must be established when the session object is built, not on a later event, or a second process can write the same file. |
| `core/extensions/runner.ts` | For `session_before_compact`, other extensions run first and the resident last; a non-resident handler that returns a compaction or a cancellation is rejected before the writer runs. Errors thrown by the resident, and any error during `session_before_compact`, are propagated instead of swallowed. | Handler ordering and error propagation are decided by the runner. An extension cannot control what happens to another extension's return value or its own thrown error. |
| `core/session-manager.ts` | Session storage goes through `SessionStorage`: writes are validated and written to disk under a lease before entries are published to the in-memory tree, including the first flush. Opening a file validates the branch. Context assembly skips older compaction entries inside a retained turn; the entries remain archived. This is the largest host change. | Session events fire after the in-memory tree has already changed. Disk-before-memory ordering has to sit in the code that owns both. Context assembly is also used directly by the SDK and compaction preparation, before an extension's `context` hook. |
| `index.ts` | Exports `contextMemory` from the package entry so SDK integrators can reach the API. | Package exports are declared in the entry file. |

Rough size of each change, counted as added plus removed lines against the upstream file:

| File | Lines |
| --- | --- |
| `core/session-manager.ts` | about 260 |
| `core/agent-session.ts` | about 20 |
| `core/agent-session-runtime.ts` | about 13 |
| `core/extensions/runner.ts` | about 12 |
| `core/sdk.ts` | about 10 |
| `index.ts` | 2 |

To reproduce the count, check out upstream `v0.86.0` next to this repository and run `diff -u` on each file.

## Build fingerprint

`scripts/stamp-context-memory.mjs` hashes the upstream commit, the host files and every `.ts` file in the extension directory into a build string of the form `0.86.0-context-memory.<project version>+src.<hash>`. The string is shown by `/compaction-status` and recorded in every compaction event, so a report can be tied to the exact source that produced it. Any new host change must be added to the file list in that script.

## Test dependency maintenance

v0.2.2 updates Vitest and its matching coverage packages from 4.1.9 to 4.1.11 for GHSA-82fw-gwwq-j7x9. The ten workspace manifests and root workspace lock move together. Generated production shrinkwrap and installer locks are checked with the existing generators; this development-only patch does not change the seven compaction host files or production dependency versions.

## v0.2.4: Pi v0.86.0 port

v0.2.4 adopts Pi v0.86.0; v0.2.3 published assets retain their original baseline. `session-manager.ts` combines exclusion of old checkpoint summaries with upstream exclusion of superseded system messages. The latest checkpoint carries the complete prompt/tool state. `runner.ts` snapshots handlers after ordering the resident last, preserving unsubscribe behavior within a dispatch. The writer uses transcript system messages when available, with the legacy header fallback retained for older sessions.

Existing provider URL-domain checks, model-data build hardening and linear-time LaTeX script normalization are preserved from the prior distribution. They are separate from the six compaction integration files.

The v0.2.4 security review also changes `packages/ai/src/utils/overflow.ts` to avoid ambiguous whitespace backtracking and `packages/agent/src/harness/pico3/kinds/tool.ts` to prevent inherited-property writes from malformed persisted slot indices. These are separate upstream security repairs, not additional compaction integration hooks. Both files are included in the build fingerprint and have focused regression coverage in the security check script.
