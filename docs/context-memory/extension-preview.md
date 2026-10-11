# Independent extension preview — v0.3.1

This preview runs on unmodified official Pi **1.1.0**. It is distributed through
the `extension-preview` Git branch, separately from the v0.3.0 resident source
build. The repository's default branch is a development monorepo; select the
package branch or package tag when installing into Pi.

## Install, update and remove

With official Pi 1.1.0 already installed, run:

```sh
pi install git:github.com/youxi-huang/pi-context-compaction@extension-preview
pi update --extension git:github.com/youxi-huang/pi-context-compaction@extension-preview
pi remove git:github.com/youxi-huang/pi-context-compaction@extension-preview
```

Restart Pi after installation or an extension update. Begin with a fresh text
session, finish a turn, then run `/compact` and `/compaction-status`.
The branch source follows subsequent compatible preview releases when updated.
`pi update` by itself updates Pi. `pi update --extensions` updates all installed extension packages; `--extension <source>` selects this package only.

To pin this exact package, use
`git:github.com/youxi-huang/pi-context-compaction@extension-v0.3.1` instead.
Tags and commits stay pinned; remove the configured old source and install the
new tag to change versions. Install one source for this package at a time.
A compatible older preview can reopen its own checkpoint schema; resident and
native checkpoints are not migrated.

The [v0.3.1 release](https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.3.1)
also provides the extension `.tgz`, source archive, provenance and SHA256 checksums.
The Git package contains five reviewed files and no host runtime. It is not
published to npm; `private: true` prevents accidental registry publication and
does not prevent Pi's Git installation. Updating or removing the extension
preserves Pi credentials, other package registrations and session files.

## Build from source

With the repository's development dependencies installed, run:

```sh
node scripts/context-memory-preview-build.mjs
pi install ./.artifacts/context-memory-preview-package
```

The builder produces an extension-only directory and an npm-compatible `.tgz`
with five reviewed files. It bundles this project's code, keeps Pi and TypeBox
as host-provided peers, and records a separate source fingerprint. It does not
rebuild or replace Pi. The package version is 0.3.1, with the clean source commit
and independent source fingerprint recorded in `preview-build.json`.

A local-path install loads that directory without copying it. Build and
verification commands in this guide run from the development repository,
checked out at source tag `v0.3.1`, with its development dependencies installed.

## Supported workflow

Use Node.js 22.19 or newer and a fresh, persistent text session. Keep one Pi
writer process per session and load this package through normal CLI/TUI/SDK
extension discovery. Finish a turn, use `/compact`, inspect
`/compaction-status`, and continue. The model can submit optional source-linked
candidates with `context_note` and retrieve original records on the current
branch with `context_history`. The JSONL remains the only history store.

For SDK use, select the same agent directory through `PI_CODING_AGENT_DIR`
before importing Pi and pass it consistently to the session/resource loader.
The extension uses public `getAgentDir()` for configuration and operational
state; an SDK-only alternate agent directory is outside this candidate's scope.

The default writer is the session model with its current thinking level. A
fixed writer can be explicitly configured in `pi-context-memory.json` inside
Pi's agent directory. Authentication stays with Pi's public model registry;
the package does not copy credentials or choose a substitute on failure.

Configuration is latched for the process; restart Pi after changing it. The
candidate uses writer, note-budget, repair and retained-text settings from
that file. `compactAt` bounds the manual checkpoint budget but does not start
automatic compaction; resident event logging and its report are not provided.
Setting `enabled: false` and restarting ends the package's protection.

This first candidate is for manual compaction at completed turns. Automatic
compaction, unfinished tool rounds, in-memory sessions, attachments, context
edits, old checkpoints, parent-history grants and other context-transforming
or compaction extensions are outside its verified scope. Unsupported
compaction is cancelled explicitly, without native summary fallback.

While enabled, this candidate returns `stop` from Pi's public cache-warming
decision event. Background warming bypasses ordinary request guards and can
append usage records during a writer snapshot, so it is paused without changing
the user's settings. Normal provider prompt caching remains available.

## Failure and recovery

An attempt writes a pending operational marker before calling the writer.
Invalid JSON, incorrect quotations, unreadable sources, unavailable writers,
cancellation and changed source snapshots stop the attempt. No replacement
summary is requested. Further model requests are aborted while the package
remains loaded, including after new input, reload and reopening a session
with a persisted pending or blocked marker.

Use manual `/compact` for an explicit retry. A retry only clears the block
after the returned checkpoint and its exact source prefix have been read
back from the actual session JSONL. There is no clear-failure command that
lets a prompt bypass this confirmation. `/compaction-status` shows the state
without calling a model.

If Pi saved the checkpoint but the commit confirmation was interrupted, use
`/compaction-recover`. It only confirms a current-leaf checkpoint with the exact
staged candidate hash and unchanged sources, after note and disk validation.
It cannot clear a writer failure or a checkpoint that was never staged.

If a blocked session ends exactly at an older successful checkpoint without a
staged attempt, stock Pi may report `Already compacted` before invoking the
extension. Add a short text retry request; it remains blocked and is preserved
as unfinished input, then use `/compact`. Recovery keeps that whole input turn.
Initialization failures before any completed source turn, unsupported session
formats and incompatible hosts require a fresh supported session after fixing
the cause. Neither recovery command forces those cases through validation.

Markers contain identifiers, hashes and controlled error codes, never note
text, transcript content or credentials. Marker IO errors block the current
process. If the very first pending marker cannot write any bytes, no durable
failure record exists; that failure cannot be promised across a process
restart once the storage fault has been repaired. An already durable pending
marker remains blocking if a later stage or checkpoint write fails.

Readback is bounded to 64 MiB and 250,000 JSONL records per session. Larger
files are blocked explicitly; they are outside this first candidate's support.
The current implementation validates the file on request guards and does not
yet optimize repeated disk reads of long sessions.

Pi owns checkpoint append and may expose it in memory before the extension
confirms disk state. The package checks publication before resuming requests;
it does not provide the resident build's disk-before-memory writes or leases
over all host operations. Removing, disabling or filtering out the package
ends its protection. Leave a blocked session with the package enabled and
use the explicit retry operation.

## Verification

Focused tests run through `scripts/context-memory-check.mjs`. The independent
acceptance runner tests the actual built artifact against an isolated official
npm Pi installation, using synthetic credentials and a loopback provider:

```sh
npm install --prefix ./.artifacts/context-memory-preview-stock \
  --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact \
  @earendil-works/pi-coding-agent@1.1.0
node scripts/context-memory-preview-acceptance.mjs \
  --package-dir ./.artifacts/context-memory-preview-package \
  --stock-root ./.artifacts/context-memory-preview-stock \
  --output-dir ./.artifacts/context-memory-preview-acceptance
```

This is deterministic protocol and lifecycle verification. It does not measure
real-provider compatibility, semantic recovery quality, compaction latency or
Windows behavior. No official Pi source, real account, existing user settings
or session is modified by these isolated checks.

The scenario runner checks the same artifact under default Pi and extension
settings, each case beside a control run without the extension. The second
installation is optional and only serves the other-version case:

```sh
npm install --prefix ./.artifacts/context-memory-preview-stock-1.0.4 \
  --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact \
  @earendil-works/pi-coding-agent@1.0.4
node scripts/context-memory-preview-scenarios.mjs \
  --package-dir ./.artifacts/context-memory-preview-package \
  --stock-root ./.artifacts/context-memory-preview-stock \
  --other-stock-root ./.artifacts/context-memory-preview-stock-1.0.4 \
  --output-dir ./.artifacts/context-memory-preview-scenarios
```

Every scenario check states intended behavior. Checks in the script's
`KNOWN_GAPS` list describe behavior this candidate does not provide yet, such
as surviving Pi's automatic retry after a transient provider failure or
leaving sessions it never enrolled usable. They are reported without failing
the run. A listed check that starts passing fails the run until it is removed
from the list, so each fix becomes a required regression. The long-session case
uses 20 checkpoints by default; `--perf-checkpoints 60` runs the full
measurement, which takes several minutes.

## Maintainer publication

Merge the reviewed source through a PR and confirm `verify` and all three
CodeQL checks on the final main commit. Push a new immutable `v<version>`
source tag to that commit. The **Publish extension preview** workflow verifies
those checks, rebuilds and tests the package on official Pi, creates the matching
`extension-v<version>` package tag, updates `extension-preview` without a force
push, and publishes a pre-release after all assets are uploaded. Existing public
assets and tags are never overwritten. The resident runtime retains its
v0.3.0 fingerprint because this release changes only the ordinary extension.

If publication tooling needs a fix after a source tag was created, merge the
fix through the normal PR checks. Retry **Publish extension preview** from that
main commit using its `source_tag` workflow input, or push that commit to
`release/publish-v<version>`. The job uses the reviewed tooling while rebuilding
and testing the immutable source tag; provenance records both commits. No tag
or existing public asset is replaced, and uploaded assets are not downloaded
again for verification.
