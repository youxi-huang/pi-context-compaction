# Independent extension preview — v0.3.3

This preview runs on unmodified official Pi **1.1.0** as an ordinary Pi package.
It is distributed through the `extension-preview` Git branch and immutable
`extension-v*` package tags, separately from the v0.3.0 resident source build.

## Install, update and remove

With official Pi 1.1.0 already installed, install the pinned v0.3.3 package:

```sh
pi install git:github.com/youxi-huang/pi-context-compaction@extension-v0.3.3
```

Restart Pi afterwards. Tags and commits stay pinned.

Pi records one source per package repository, so installing the same
repository with another tag or branch replaces the recorded source. To follow
later compatible previews instead of a pinned tag, install the moving branch:

```sh
pi install git:github.com/youxi-huang/pi-context-compaction@extension-preview
```

Update only this package:

```sh
pi update --extension git:github.com/youxi-huang/pi-context-compaction@extension-preview
```

`pi update --extensions` updates every installed package. A plain `pi update`
updates Pi itself and `pi update --all` updates Pi and all packages; this
preview is validated only on Pi 1.1.0.

Remove the package, whichever tag or branch is installed:

```sh
pi remove git:github.com/youxi-huang/pi-context-compaction
```

Install the package from one scope only (global by default, or project-local
with `-l`). A compatible older preview can reopen its own checkpoint schema;
resident and native checkpoints are not migrated.

The [v0.3.3 release](https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.3.3)
also provides the extension `.tgz`, source archive, provenance and SHA256 checksums.
The Git package contains five reviewed files and no host runtime. It is not
published to npm; `private: true` prevents accidental registry publication and
does not prevent Pi's Git installation. Updating or removing the extension
preserves Pi credentials, other package registrations and session files.

## First use

Start a new, persistent, text-only session. After Pi starts or reloads its
extensions, the preview shows one short line saying it is active. Then run:

```text
/compaction-doctor
```

It prints a short checklist: extension loaded, host version, session support,
writer, manual `/compact` eligibility and any durable block. It calls no model,
writes no failure record and does not change the session. Because Pi's own
compaction settings are not visible to extensions, it reports Pi's side of
`/compact` eligibility as `unknown` instead of guessing; `Result: ready` means
nothing is blocking requests, not that Pi will accept `/compact` yet.

`/compaction-status` prints the same findings as JSON. It keeps the fields of
earlier previews and, since v0.3.3, adds `host`, `supportedHost`, `protection`,
`reason` and `manualCompaction`; a pending attempt reads `pending` rather than
`blocked`.

Pi decides whether there is anything to compact before calling the extension.
With default settings Pi keeps the most recent 20,000 estimated tokens
(`compaction.keepRecentTokens`) and answers `Nothing to compact (session too
small)` until older history exists. That answer is not an extension failure and
leaves no failure record. The scenario runner reaches its first checkpoint after
about 31,000 estimated tokens of history.

## Which sessions the preview handles

The preview distinguishes three kinds of session:

- **Protected:** the session has a checkpoint written by this preview, or a
  pending or failed attempt recorded by it. Every check below is strict, and a
  failure is recorded durably.
- **Eligible:** a persistent, text-only session on Pi 1.1.0 with no
  checkpoint from another compactor. The preview handles its compaction:
  automatic compaction is cancelled and `/compact` writes a checked checkpoint.
  The first attempt, or a cancelled automatic compaction, makes it protected.
- **Not protected:** a session the preview has never protected and cannot
  check: Pi other than 1.1.0, an in-memory session, a native or other
  compactor's checkpoint, an image or other non-text content, or an
  unsupported context edit. The preview stands aside. It writes no failure
  record, does not stop requests, leaves manual and automatic compaction and
  cache warming to Pi, and says so once per session.

Only durable claims decide protection: a preview checkpoint in the session
file or a failure record. Content alone never releases a protected session.
A protected session that later gains an image, a checkpoint from another
compactor or an unsupported host stays blocked; continue the work in a new
supported session and keep the old file. An unreadable `pi-context-memory.json` stops each request
in an eligible session without recording a durable block, so fixing the file
and restarting Pi is enough; in a protected session the block is recorded.

v0.3.2 and earlier treated every session as protected: an unsupported session
had its requests blocked, and a failure record was written wherever the session
had a file.

## Build from source

With the repository's development dependencies installed, run:

```sh
node scripts/context-memory-preview-build.mjs
```

Then install the built directory:

```sh
pi install ./.artifacts/context-memory-preview-package
```

The builder produces an extension-only directory and an npm-compatible `.tgz`
with five reviewed files. It bundles this project's code, keeps Pi and TypeBox
as host-provided peers, and records a separate source fingerprint. It does not
rebuild or replace Pi. `preview-build.json` records the package version, the
clean source commit (or `null` for a working tree with changes) and the
independent source fingerprint.

A local-path install loads that directory without copying it. Build and
verification commands in this guide run from a checkout of the development
repository with its development dependencies installed.

## Supported workflow

Use Node.js 22.19 or newer and a persistent text session. Keep one Pi
writer process per session and load this package through normal CLI/TUI/SDK
extension discovery. Finish turns until Pi has older history to compact, use
`/compact`, inspect `/compaction-status`, and continue. The model can submit
optional source-linked candidates with `context_note` and retrieve original
records on the current branch with `context_history`. The JSONL remains the
only history store.

For SDK use, select the same agent directory through `PI_CODING_AGENT_DIR`
before importing Pi and pass it consistently to the session/resource loader.
The extension uses public `getAgentDir()` for configuration and operational
state; an SDK-only alternate agent directory is outside this candidate's scope.

The default writer is the session model with its current thinking level. A
fixed writer can be explicitly configured in `pi-context-memory.json` inside
Pi's agent directory. Authentication stays with Pi's public model registry;
the package does not copy credentials or choose a substitute on failure.

Configuration is latched for the process; restart Pi after changing it. The
preview uses the writer, note-budget, repair and retained-text settings from
that file. `compactAt` bounds the manual checkpoint budget but does not start
automatic compaction; the resident event log and its report are not provided.
Setting `enabled: false` and restarting ends the package's protection.

This preview is for manual compaction at completed turns. Automatic
compaction, unfinished tool rounds, in-memory sessions, attachments, context
edits other than validated recovery omissions, old checkpoints, parent-history
grants and other context-transforming or compaction extensions are outside its
verified scope. In the sessions it handles, unsupported compaction is cancelled
explicitly, without native summary fallback.

Ordinary Agent retries may append an omission of the latest failed assistant response in the current
checkpoint interval. Replacement content, user-message edits and failed
responses containing tool calls remain unsupported. Normal Agent retries do
not create a compaction failure marker. A previously blocked retry session
with sufficient completed source history can recover through explicit
`/compact`; the marker clears only after the new checkpoint is confirmed on
disk. Text-only context-overflow failures can use the same manual recovery,
which retains the unfinished user request. `/compaction-recover` still only
confirms an already staged checkpoint. Published v0.3.1 assets do not contain
the retry fix.

While a session is handled by the preview, it returns `stop` from Pi's public
cache-warming decision event. Background warming bypasses ordinary request
guards and can append usage records during a writer snapshot, so it is paused
without changing the user's settings. Normal provider prompt caching remains
available.

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
It cannot clear a writer failure or a checkpoint that was never staged, and a
refusal changes nothing. In v0.3.2 and earlier, running it with nothing staged,
including on a healthy session, recorded a `CONTEXT_PREVIEW_COMMIT_UNCONFIRMED`
block that only a successful `/compact` cleared.

If a blocked session ends exactly at an older successful checkpoint without a
staged attempt, stock Pi may report `Already compacted` before invoking the
extension. Add a short text retry request; it remains blocked and is preserved
as unfinished input, then use `/compact`. Recovery keeps that whole input turn.
Initialization failures before any completed source turn, unsupported session
formats and incompatible hosts require a fresh supported session after fixing
the cause. Neither recovery command forces those cases through validation.

Each failure and each blocked input produces one notice (v0.3.2 could repeat
the same notice two to four times). The notice names the controlled error code,
says what happened and whether requests are paused, and gives the next step;
`/compact` is suggested only where it can help. Pi's automatic compaction
request is reported as `CONTEXT_PREVIEW_COMPACT_REQUIRED` (earlier
`CONTEXT_PREVIEW_UNSUPPORTED`). After a rollback to v0.3.2, that record reads
as invalid and stays blocked until an explicit `/compact`, which recovers it;
a v0.3.2 record opened by v0.3.3 recovers the same way.

Markers contain identifiers, hashes and controlled error codes, never note
text, transcript content or credentials. Marker IO errors block the current
process. If the very first pending marker cannot write any bytes, no durable
failure record exists; that failure cannot be promised across a process
restart once the storage fault has been repaired. An already durable pending
marker remains blocking if a later stage or checkpoint write fails.

Readback is bounded to 64 MiB and 250,000 JSONL records per session. Larger
files are blocked explicitly; they are outside this first candidate's support.
Each model request re-validates every stored checkpoint and reads the session
file back from disk, three times per request. The cost grows with the number
of checkpoints and the size of the history; the
[validation record](validation.md) has measurements.

Pi owns checkpoint append and may expose it in memory before the extension
confirms disk state. The package checks publication before resuming requests;
it does not provide the resident build's disk-before-memory writes or leases
over all host operations. Removing, disabling or filtering out the package
ends its protection. Leave a blocked session with the package enabled and
use the explicit retry operation.

## Verification

Focused tests run through `scripts/context-memory-check.mjs`. The independent
acceptance runner tests the actual built artifact against an isolated official
npm Pi installation, using synthetic credentials and a loopback provider. Install
that official Pi first:

```sh
npm install --prefix ./.artifacts/context-memory-preview-stock \
  --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact \
  @earendil-works/pi-coding-agent@1.1.0
```

Then run acceptance:

```sh
node scripts/context-memory-preview-acceptance.mjs \
  --package-dir ./.artifacts/context-memory-preview-package \
  --stock-root ./.artifacts/context-memory-preview-stock \
  --output-dir ./.artifacts/context-memory-preview-acceptance
```

This is deterministic protocol and lifecycle verification. It does not measure
real-provider compatibility, semantic recovery quality, compaction latency or
Windows behavior. No official Pi source, real account, existing user settings
or session is modified by these isolated checks.

Acceptance copies the package to a temporary directory outside
any Node project and runs every case there, keeping only `report.json` and
per-case results in `--output-dir`. Inside this repository, once
`npm run build:offline` has run, a package's Pi imports resolve to the
repository's patched workspace build instead of the host under test; acceptance
runs before v0.3.3 were exposed to that. The runner stops if
its temporary directory sits inside a Node project.

The scenario runner checks the same artifact under default Pi and extension
settings, each case beside a control run without the extension. The second
installation is optional and only serves the other-version case:

```sh
npm install --prefix ./.artifacts/context-memory-preview-stock-1.0.4 \
  --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact \
  @earendil-works/pi-coding-agent@1.0.4
```

```sh
node scripts/context-memory-preview-scenarios.mjs \
  --package-dir ./.artifacts/context-memory-preview-package \
  --stock-root ./.artifacts/context-memory-preview-stock \
  --other-stock-root ./.artifacts/context-memory-preview-stock-1.0.4 \
  --output-dir ./.artifacts/context-memory-preview-scenarios
```

Every scenario check states intended behavior. Checks in the script's
`KNOWN_GAPS` list describe behavior the preview does not provide yet; they are
reported without failing the run. A listed check that starts passing fails the
run until it is removed from the list, so each fix becomes a required
regression. The runner also loads a copy of the package from a temporary
directory outside the repository. The long-session case uses 20 checkpoints by
default; `--perf-checkpoints 60` runs the full measurement, which takes several
minutes.

## Maintainer publication

Merge the reviewed source through a PR and confirm `verify` and all three
CodeQL checks on the final main commit. Push a new immutable `v<version>`
source tag to that commit. The **Publish extension preview** workflow verifies
those checks, rebuilds and tests the package on official Pi, creates the matching
`extension-v<version>` package tag, updates `extension-preview` without a force
push, and publishes a pre-release after all assets are uploaded. Existing public
assets and tags are never overwritten. The resident runtime retains its
v0.3.0 fingerprint because the preview changes only the ordinary extension.

If publication tooling needs a fix after a source tag was created, merge the
fix through the normal PR checks. Retry **Publish extension preview** from that
main commit using its `source_tag` workflow input, or push that commit to
`release/publish-v<version>`. The job uses the reviewed tooling while rebuilding
and testing the immutable source tag; provenance records both commits. No tag
or existing public asset is replaced, and uploaded assets are not downloaded
again for verification.
