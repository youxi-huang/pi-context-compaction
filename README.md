# Pi Context Compaction

**Compact the context, not the evidence.**

Long coding sessions often depend on decisions made much earlier: a failed attempt, a change of direction, a constraint the user added halfway through. A compacted summary can carry the work forward, but it rarely says where those decisions came from.

Pi Context Compaction explores a more traceable handover for [Pi](https://github.com/earendil-works/pi). It writes a structured note with references to the original session records, checks those references before the checkpoint is committed, and gives the agent a way to read the earlier messages again when a detail matters.

The goal is **continuity with a route back to the source**, not perfect memory.

**Current release:** [v0.5.1](https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.5.1) is an **independent extension preview** for unmodified official **Pi 1.3.0, 1.2.0 and 1.1.0**. It supports `/compact` and Pi's threshold compaction after completed turns in persistent, text-only sessions, and leaves sessions it cannot check to Pi.

**Before updating Pi:** check that the preview lists the new version. On an unlisted Pi, a session the preview already protects stays blocked until it is reopened with a listed version; see [before updating Pi](docs/context-memory/extension-preview.md#before-updating-pi).

Two optional experiments are **off by default**: A prepares with the configured writer, and B uses data-only work notes from the session model. Both retain the checkpoint commit checks; B carries covered user messages in full or falls back to the writer. Sources are validated in full at trust boundaries, with incremental request checks between them. Synthetic A/B results show the paths and their costs; real-provider pause, cost and recovery benefits remain unproven. v0.4.1 fixes how checkpoints carry notes; see the [v0.4.0 scope and evidence](docs/context-memory/v0.4.0-release.md) and the [v0.4.1 changes](CHANGELOG.md).

[Install](#install-in-pi) · [First use](#your-first-session) · [How it works](#how-it-works) · [Scope](#what-this-preview-supports) · [Recovery](#when-something-goes-wrong) · [Evidence](#what-has-been-tested)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/context-memory/assets/pi-context-compaction-hero-editorial-dark.png">
  <img src="docs/context-memory/assets/pi-context-compaction-hero-editorial.png" alt="An illustrative handover cites a port failure and a later user decision. The citations lead back to original session entries retained on disk, which the agent can read again on the current session branch.">
</picture>

## Install in Pi

You need:

- Official [Pi](https://github.com/earendil-works/pi) **1.3.0, 1.2.0 or 1.1.0**, already installed and working with your chosen model.
- **Node.js 22.19 or newer**.
- macOS or Linux. Windows has not been validated.

Install the pinned package from your terminal:

```sh
pi install git:github.com/youxi-huang/pi-context-compaction@extension-v0.5.1
```

Preparation and work notes remain off until explicitly configured. The [extension guide](docs/context-memory/extension-preview.md) describes their limits and configuration.

That is the whole installation. You don't need to clone this repository, rebuild Pi or configure a second model. Restart Pi afterwards.

**Why `extension-v0.5.1` and not `v0.5.1`?** They are different Git tags. `extension-v0.5.1` holds the small installable package. `v0.5.1` marks the development source tree, which is not a Pi package. The repository's default branch is the source tree too, so install by package tag (or by the `extension-preview` branch described [below](#update-or-remove)).

The extension does not replace Pi's executable or copy its credentials. Authentication stays in Pi's own configuration.

## Your first session

Start a **new, persistent, text-only** Pi session. Pi shows `Source-linked compaction is on.`, and its footer keeps the preview's state in view: `compaction: on`, the number of checkpoints on the current branch, `writing note` while it compacts, or `paused` when requests are held. Then enter:

```text
/compaction-doctor
```

It checks, without calling a model or changing anything, that the extension loaded, that this is a supported Pi version, that the session is one the preview can handle, which writer it will use, and whether anything is blocking requests. `Result: ready` means nothing is in the way; **it does not mean the conversation is long enough to compact yet**, which is why the manual `/compact` line reads `unknown`.

Keep working normally. Once the session has accumulated enough completed text history, ask for a checkpoint:

```text
/compact
```

Pi decides first whether there is anything to compact. By default it keeps the most recent 20,000 estimated tokens as they are (Pi's `compaction.keepRecentTokens` setting) and only compacts what lies before them. In a short session Pi answers `Nothing to compact (session too small)` before the extension is called. That is Pi saying "not yet", not a failed installation, and you don't need an artificial long conversation just to check that the extension loaded.

After a successful checkpoint, `/compaction-status` shows the checkpoint and reports the session as `protected`. From then on the agent can use `context_history` to search or read the original entries on the **current session branch**. Those entries stay in the session's JSONL file.

When a completed turn reaches Pi's compaction threshold, the extension writes the same checked checkpoint automatically. A blocked session or a context-overflow failure still needs explicit `/compact` recovery. The extension pauses background cache warming in the sessions it handles; normal provider prompt caching is unaffected.

**Older sessions are left alone.** If you open a session the preview never handled and cannot check, such as one with Pi's own checkpoints or with images, the preview says so once and stands aside. It records nothing, stops no request, and Pi's own compaction applies as before.

## Why keep the original evidence?

Imagine a task in which port `9000` failed, `4317` was approved as a replacement, and a later user decision moved the service to `4318` with timeout `9500`.

A short handover might keep only the latest port. It could lose the reason for the change, or blur the earlier approval into the later one. A source-linked handover can send the agent back to the original failure and to the later instruction.

That is what the two layers below show: a compact note for continuing the task, and an unchanged session record that can still be consulted.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/context-memory/assets/source-linked-compaction-dark.png">
  <img src="docs/context-memory/assets/source-linked-compaction.png" alt="A compact handover note sits above the original session record. Its source references point back to individual original messages, which remain stored in order and can be read again.">
</picture>

The port example is illustrative. It follows a [documented provider scenario](docs/context-memory/validation.md#real-provider-scenario) and is not a screenshot of an interactive run.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/context-memory/assets/recovery-example-dark.png">
  <img src="docs/context-memory/assets/recovery-example.png" alt="An illustrative sequence: port 9000 fails, 4317 is approved, and a later ruling chooses 4318 with timeout 9500. Separate history lookups recover the original failure and the later instruction.">
</picture>

## How it works

1. **Write a handover.** By default the session's own model writes a structured note; a fixed writer can be configured instead. The note records task state, decisions, next steps and source references.
2. **Check the note before committing it.** Every cited source must be on the selected branch, every quotation must appear verbatim in the entry it cites, the note must be valid, and the checkpoint must be confirmed in the session file on disk before work continues.
3. **Go back to the record when it matters.** The agent can use `context_history` to find the original entries instead of relying on the latest summary alone.

The session JSONL remains the source of truth. Notes and checkpoints help the agent navigate it; they don't replace it. These checks establish **reference consistency**, not semantic completeness. A note can pass every check and still leave out something important, and the model can still misread what it retrieves.

The diagram below shows the commit checks. It was first drawn for the **resident** build and shows the validation boundary, **not** the preview's full failure and recovery behavior. In the preview, a failed compaction keeps requests paused until an explicit retry or a staged-checkpoint recovery is confirmed on disk.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/context-memory/assets/commit-gate-dark.png">
  <img src="docs/context-memory/assets/commit-gate.png" alt="A proposed handover note passes checks of source membership, verbatim quotations, validity and checkpoint publication before it can become the continuation checkpoint. A failed attempt cannot publish an unchecked note.">
</picture>

The [architecture](docs/context-memory/architecture.md) covers the note format, budget rules, history access and the commit boundary in detail.

## What this preview supports

The scope is deliberately narrow, so that its behavior can be tested and explained.

**Supported in v0.5.1**

- Official Pi **1.3.0, 1.2.0 or 1.1.0**, with the extension installed independently of Pi.
- Persistent, text-only sessions, either new or already handled by this preview, with one Pi process writing each session.
- Manual `/compact` and Pi's threshold compaction after a completed text turn, followed by source-linked history retrieval on the same branch.
- Optional same-writer preparation (A) and data-only session-model work notes (B), both off by default, with a journal of writer calls and validated prefix commits.
- The session model as the default note writer, or an explicitly configured fixed writer.
- Pi's ordinary retries after transient provider failures, including connections dropped mid-response.
- Explicit manual recovery for some previously blocked retry sessions and for text-only context-overflow failures, when enough completed history remains.

**Not supported or not yet verified**

- Compaction during unfinished turns and automatic overflow recovery; sessions with images or other attachments; in-memory sessions (`--no-session`); unfinished tool rounds.
- Migration of native Pi or resident-build checkpoints; parent-history grants; memory across sessions.
- Concurrent writers, competing compactors, other context-rewriting extensions, or any Pi version outside 1.3.0, 1.2.0 and 1.1.0.
- Windows, long-running real-provider reliability, and recovery quality with real models.

What happens in an unsupported session depends on whether the preview already protects it. A session becomes **protected** once the preview has written a checkpoint for it or recorded a pending or failed attempt. A session it never protected and cannot check is left to Pi, as described above. A protected session that later gains an image or a checkpoint from another compactor, or is opened on an unsupported Pi version, keeps its **requests blocked** rather than fall back to Pi's native compactor; continue that work in a new text session and keep the old file.

## When something goes wrong

Start with `/compaction-doctor` for a plain-language check, or `/compaction-status` for the same findings as JSON: the extension build, the selected writer, checkpoint information, the session's protection, and whether requests are `ready`, `pending` or `blocked`, with a controlled error code. A failure notice explains what happened and what to do, with the code last. Later inputs blocked by the same code get a short reminder until a checkpoint or recovery is confirmed.

If a compaction attempt fails because the note, its sources, the writer or the on-disk state could not be checked, **the extension does not publish an unchecked summary or quietly switch to another writer**. Requests stay paused across new input, `/reload` and reopening the session. Text typed while paused stays in the interactive editor, without starting a request or entering the session history.

Two commands do different jobs:

- **`/compact`** retries the checkpoint once you have fixed the cause. The block clears only after the new checkpoint has been checked and found in the session file.
- **`/compaction-recover`** is narrower. It confirms a checkpoint that Pi **already saved** after the extension staged it, when the final confirmation was interrupted. It cannot turn an unstaged writer failure into a success, and when there is nothing to confirm it says so and changes nothing.

A protected session that gained old checkpoints from another compactor, image content or an unsupported Pi version needs a new session; neither command migrates it. Please keep the original session file. Disabling or removing the extension ends its protection, but it is **not** a verified way to recover a blocked checkpoint.

[Usage and recovery](docs/context-memory/extension-preview.md) lists the exact supported cases, the configuration file and the special recovery conditions.

## Update or remove

Pi records one source per package repository. Installing the same repository with a different tag or branch **replaces** the recorded source; it never adds a second copy. Restart Pi after any install or update.

The installation above is **pinned** to `extension-v0.5.1` and stays there until you install a different package tag.

To follow later previews automatically instead, install the **moving `extension-preview` branch**, which replaces the pinned tag:

```sh
pi install git:github.com/youxi-huang/pi-context-compaction@extension-preview
```

To update only this package when you follow the branch:

```sh
pi update --extension git:github.com/youxi-huang/pi-context-compaction@extension-preview
```

A pinned tag does not move when updated. A plain `pi update` updates **Pi itself**, and `pi update --all` updates Pi and every package. v0.5.1 targets Pi 1.3.0, 1.2.0 and 1.1.0, so check the supported version [before updating Pi](docs/context-memory/extension-preview.md#before-updating-pi).

To remove the package, whichever tag or branch you installed:

```sh
pi remove git:github.com/youxi-huang/pi-context-compaction
```

Updating or removing the package does not migrate, rewrite or delete sessions, and it leaves other packages and Pi's credentials alone.

The [v0.5.1 release](https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.5.1) also carries the extension archive, a source archive, checksums, provenance and exact-package scenario evidence. The preview is distributed through Git, not npm.

## What has been tested

The project publishes failures and limits next to the passing checks. v0.5.1 requires these gates on the final source and package:

| Evidence | Scope |
| --- | --- |
| Focused script, resident and preview regressions | `context-memory-check.mjs`, including preparation, call accounting, persistence and user-message retention |
| Host security and compatibility checks | `security-regression-check.mjs`, with synthetic inputs and mocked providers |
| Frozen offline evaluator | `eval/check.mjs`, scripted evaluation separate from the preview |
| Stock-Pi package and lifecycle acceptance | Install, update, removal, the read-only self-check, checkpoint validation, failure and recovery on isolated official Pi 1.3.0, 1.2.0 and 1.1.0, including cross-version checkpoints |
| Full default-settings scenarios, strict profile | Pi 1.3.0 stock controls, Pi 1.0.4 refusal, A and B paths, and both long-session overhead checks; no performance waiver or known gap |

None of this shows better recovery than native Pi. The preview's acceptance and scenario runs use isolated synthetic and loopback services; they say nothing about real-provider latency, interactive TUI behavior or everyday robustness. Earlier live results belong to the resident build. Bounded provider runs of the preview with DeepSeek V4.1 Flash on Pi 1.3.0 are recorded separately: for v0.5.0, a writer bench and recovery probes on three synthetic sessions. On the two sessions both writers ran, v0.5.0 builds committed 37 to 40 of 40 notes against 32 for the v0.4.3 writer, and on the session built for retrieval every probe passed. For v0.5.1, the quotation repair without reasoning passed 76 of 76 attempts on 38 planted cases against 75 of 76 at `high`, and in writer benches beside a same-day run of the v0.5.0 release build the candidate committed 121 of 128 notes against 62 of 64. One model on synthetic sessions measures neither a general failure rate nor a benefit over native Pi.

The [validation record](docs/context-memory/validation.md) has the scenarios, methods, failed attempts and measured costs. The [roadmap](docs/context-memory/roadmap.md) says what remains open, and the [changelog](CHANGELOG.md) lists each release.

## For maintainers and contributors

No source build is needed to use the preview. The default branch is a **development monorepo**; `extension-preview` and the `extension-v*` tags carry the installable package. The separate v0.3.0 **resident** build changes six Pi host files and is kept for development and comparison, not as the normal way to install.

<details>
<summary>Build the resident source for comparison</summary>

Requirements: Node.js 22.19 or newer, npm, Git, curl and tar.

```sh
git clone https://github.com/youxi-huang/pi-context-compaction.git
cd pi-context-compaction
git checkout v0.3.0
npm ci --ignore-scripts
node scripts/context-memory-model-data.mjs
node scripts/stamp-context-memory.mjs
npm run build:offline
node scripts/context-memory-check.mjs
```

The model-data helper downloads the pinned upstream source release, checks its SHA-256 and extracts the public model catalog for the offline build; it does not read Pi configuration or call a model.

To launch the built resident host with ordinary extension discovery disabled:

```sh
node packages/coding-agent/dist/bundle/cli.js --no-extensions
```

This is not an installation of the independent preview and is unrelated to `pi install`. Resident configuration, event logging and compatibility notes are in [Configuration and operation](docs/context-memory/configuration.md).

</details>

To work on the independent preview, start with [the extension guide](docs/context-memory/extension-preview.md), the [agent instructions](AGENTS.md) and the [operations runbook](docs/context-memory/operations.md). Contributions should keep the original evidence, avoid silent fallbacks, and separate synthetic tests from real-provider observations.

Session records stay in local JSONL files, but relevant content is sent to the selected model when a note is written or history is retrieved. Please leave real transcripts, credentials and identifying local paths out of bug reports; a synthetic reproduction and the extension build ID help more. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [Discussions](https://github.com/youxi-huang/pi-context-compaction/discussions).

The project was first called Pi Context Memory. Source paths under `context-memory`, the `pi-context-memory.json` configuration file, the `contextMemory` API and stored checkpoint identifiers keep that name; the rename needs no migration.

## License and acknowledgments

MIT. Pi keeps its own license and copyright; new context-memory code is under the same license. See the [third-party notices](THIRD_PARTY_NOTICES.md).

The design was inspired in part by OpenAI's [public description](https://learn.chatgpt.com/docs/models) of notes across context windows and retrieval of earlier task messages, and by public community work on agent context management. Codex assisted development. This project is independently maintained and is not an official Pi or OpenAI release; no OpenAI context-management implementation has been copied.

The original Pi README is kept as [UPSTREAM_README.md](UPSTREAM_README.md). Its release and support instructions apply to upstream Pi, not to this project.
