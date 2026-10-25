# SLICE

**Compact the context, not the evidence.**

A long coding session leaves behind decisions that still matter: a failed attempt, a workaround that was approved, a constraint introduced much later. A short summary can carry the task forward, but it may no longer show where those decisions came from.

SLICE (**Source-Linked Indexed Compaction of Everything**) offers a way back. It writes a compact handover linked to the original session entries, checks those links before committing a checkpoint, and lets the agent revisit the record when a detail matters. The original history stays in place.

The aim is continuity with evidence, not perfect memory.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/context-memory/assets/pi-context-compaction-hero-editorial-dark.png">
  <img src="docs/context-memory/assets/pi-context-compaction-hero-editorial.png" alt="A compact handover cites an earlier failure and a later decision, with references back to the original session entries.">
</picture>

SLICE currently runs as an independent extension for [Pi](https://github.com/earendil-works/pi). Its host-neutral core is in the source tree, with Pi as the first adapter. Other hosts are planned, not yet available.

**Current release:** [v0.7.1](https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.7.1), validated on unmodified official Pi **1.4.0, 1.3.0, 1.2.0 and 1.1.0**. It is the first extension built on the v0.7.0 core and behaves as v0.6.0 did. Until this release the project was called Pi Context Compaction.

[Get started](#get-started) · [How it works](#how-it-works) · [Current scope](#current-scope) · [Evidence](#evidence-and-limits)

## Get started

You need a working installation of official Pi **1.4.0, 1.3.0, 1.2.0 or 1.1.0**, **Node.js 22.19 or later**, and macOS or Linux. Windows has not been validated.

Install the published extension:

```sh
pi install git:github.com/youxi-huang/pi-context-compaction@extension-v0.7.1
```

Restart Pi and begin a new, persistent, text-only session. Then run:

```text
/compaction-doctor
```

The doctor checks whether the extension loaded, whether the host and session are supported, and whether requests can continue. It does not call a model or alter the session.

Work as usual. When Pi has enough earlier history to compact, you can run `/compact`. The same checked handover also runs when a completed turn reaches Pi's compaction threshold. After a checkpoint, `/compaction-status` shows its state and the agent can use `context_history` to search or read earlier entries on the current branch.

If Pi says `Nothing to compact (session too small)`, there simply is not enough older history yet. That is not an installation failure.

There is no Pi source patch, separate model or second history service to set up. By default the extension writes with the session's own model, and Pi continues to manage authentication.

The repository keeps the name `pi-context-compaction` for now, so existing installations need no change. **`extension-v0.7.1` is the installable package tag; `v0.7.1` marks the source tree, which is not a Pi package.** Please use the installation command above rather than installing the development tree.

## Why keep the evidence?

Consider a service that first failed on port `9000`. Port `4317` was approved as a replacement, and a later decision changed it to `4318`. The latest port is easy to put in a summary. Why it changed, and which decision superseded which, is harder to preserve.

A source-linked handover can point the agent back to the original failure, the approval and the later instruction. The checkpoint helps the work continue; it does not become the sole account of what happened.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/context-memory/assets/source-linked-compaction-dark.png">
  <img src="docs/context-memory/assets/source-linked-compaction.png" alt="A short handover note points to its supporting entries in the unchanged session record.">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/context-memory/assets/recovery-example-dark.png">
  <img src="docs/context-memory/assets/recovery-example.png" alt="An illustrative sequence: port 9000 fails, 4317 is approved, and a later ruling chooses 4318 with timeout 9500. Separate history lookups recover the original failure and the later instruction.">
</picture>

*The port example is illustrative, based on a [documented provider scenario](docs/context-memory/validation.md#real-provider-scenario).*

## How it works

**Write a handover.** At a compaction point, the model produces a structured note about the task, the decisions made and the work still open. Each fact carries references to the session entries that support it.

**Check before committing.** The extension checks the note's structure, verifies that cited entries belong to the current branch and that quoted text occurs in its cited source, then confirms the checkpoint in Pi's session file. It does not quietly replace a failed note with an unchecked summary.

**Return to the record.** The agent can use `context_history` to find an earlier decision, read an original message or check how a constraint changed. The session's JSONL remains the underlying history, rather than a separate reconstructed memory.

These are checks of **source and record consistency**. They cannot show that a note contains every important fact or that a model will interpret retrieved evidence correctly. SLICE keeps the route back to the original; it does not remove the need for judgment.

The [core specification](packages/compaction-core/spec/specification.md) sets out the record, checkpoint and validation contracts.

## Current scope

The published Pi preview handles persistent, text-only sessions, with one Pi process writing each session. It supports manual `/compact` and threshold compaction after completed turns, followed by retrieval from the same session branch.

The default path uses the session model to write a checked checkpoint. A fixed writer can be configured. Further work is available behind **opt-in switches, all off by default**:

- **Preparation and work notes:** prepare a checkpoint with the configured writer, or use data-only notes from the session model.
- **Reversible context reduction:** shorten eligible earlier tool results in the active view while leaving the original entries unchanged.
- **Selective excerpts and rendering:** bring back a small piece of earlier evidence when an identifier is mentioned, or render a more compact view of a stored note without changing that note.

These experiments have narrower evidence than the default path. The [extension guide](docs/context-memory/extension-preview.md) explains how to enable them and what each one can and cannot do.

The preview does not compact unfinished turns, and after a context overflow it waits for an explicit `/compact` rather than recovering automatically. It does not support images or other attachments, in-memory sessions, competing compactors, migration of Pi-native checkpoints or memory across sessions. Pi versions outside the four listed above have not been validated.

**Failure is visible.** If a protected session's note, references or saved checkpoint cannot be confirmed, requests stay paused rather than continuing from an unverified handover. After fixing the cause, `/compact` retries; `/compaction-recover` only confirms a checkpoint Pi has already saved after it was staged. Neither command can migrate an unsupported session.

For sessions SLICE has never protected and cannot check, it stands aside and leaves compaction to Pi. A previously protected session opened on an unsupported Pi version instead stays blocked. **Check the [supported versions before updating Pi](docs/context-memory/extension-preview.md#before-updating-pi)** and keep the original session file if recovery is needed.

## Evidence and limits

Each release is published only after its exact package passes acceptance on isolated installations of every listed official Pi, covering install, update and removal, checkpoint persistence, failure handling and checkpoints reopened across versions. The broader scenario and performance tests use synthetic sessions and loopback services. The v0.7.0 core extraction produced byte-identical results to the earlier code on scripted inputs, and the core is checked against a host-neutral conformance suite.

There are also bounded tests with real models. They are reported separately, with failures and provider limitations, and do not establish better everyday recovery, lower real-provider costs or long-running reliability compared with Pi's native compaction. The optional reduction and rendering results remain preliminary.

You can review the [validation record](docs/context-memory/validation.md), [changelog](CHANGELOG.md) and [roadmap](docs/context-memory/roadmap.md). The results are evidence for specific checks, not a claim that every long session will be recovered correctly.

## Updates and recovery

The command above pins a release. If you would rather follow the moving preview branch, install it instead:

```sh
pi install git:github.com/youxi-huang/pi-context-compaction@extension-preview
```

To update only that branch-based package:

```sh
pi update --extension git:github.com/youxi-huang/pi-context-compaction@extension-preview
```

Pi records one source per package repository, so installing the same repository with another tag or branch replaces the recorded source rather than adding a second copy.

To remove the extension:

```sh
pi remove git:github.com/youxi-huang/pi-context-compaction
```

Restart Pi after installation or update. A pinned tag does not move when updated; a plain `pi update` updates Pi itself. Updating or removing the extension does not rewrite the session history, and removing it is not a verified recovery method for a blocked checkpoint.

For specific failure states and recovery steps, see the [extension guide](docs/context-memory/extension-preview.md#failure-and-recovery).

## Development and care

SLICE's shared method lives in [`packages/compaction-core`](packages/compaction-core), separate from Pi's lifecycle and model transport. The Pi extension is the first adapter. The earlier resident build, which changed Pi's own source, is frozen and retained for comparison, not recommended for installation. See the [0.7.0 plan](docs/context-memory/v0.7.0-plan.md) and [operations runbook](docs/context-memory/operations.md) for the development and verification boundaries.

The repository, the Git package source, the package name, the `/compaction-*` commands and stored identifiers such as `context-memory` and `pi-context-memory.json` retain their established names. They do not need to change for the SLICE name to be used here, and existing checkpoints require no migration.

Original sessions remain in local JSONL files. Relevant content is still sent to the selected model when a note is written or history is returned to the agent. Please use synthetic examples rather than real transcripts, credentials or identifying paths in reports. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [Discussions](https://github.com/youxi-huang/pi-context-compaction/discussions).

The design was inspired in part by OpenAI's [public description](https://learn.chatgpt.com/docs/models) of notes across context windows and retrieval of earlier task messages, and by public community work on agent context management. No OpenAI context-management implementation has been copied. Codex assisted development.

SLICE is independently maintained and is not an official Pi or OpenAI release. It is MIT-licensed; Pi keeps its own license and copyright. See [LICENSE](LICENSE) and the [third-party notices](THIRD_PARTY_NOTICES.md). The original Pi README is kept as [UPSTREAM_README.md](UPSTREAM_README.md); its release and support instructions apply to upstream Pi, not to SLICE.
