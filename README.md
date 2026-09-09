# Pi Context Compaction

Context compaction for [Pi](https://github.com/earendil-works/pi), with source-linked notes, original-history retrieval and write safeguards.

**Latest tagged release: `v0.1.1`, an experimental source distribution based on Pi `v0.85.1`.** This repository includes the host changes needed for persistent writer leases, commit ordering and resident extension loading. It is not a drop-in extension for an unmodified Pi installation.

At compaction, a fixed writer produces a structured note from original session records. The next model can retrieve earlier messages and tool results through `context_history`, including the entry IDs behind a decision. Optional `context_note` calls supply candidates; boundary compaction still works if a model never calls that tool.

The scope is preserving task continuity when model context is compacted. History access follows the current session branch and explicit parent-history grants; this project does not provide a general cross-session memory or user-preference store.

## What it provides

- A resident context extension that survives ordinary extension filtering and reload.
- Disk-before-memory checkpoint publication, cooperative writer leases and explicit failure states.
- Notes with validated source references and exact quotations; the original JSONL remains the history store.
- Branch-scoped search and paginated reads, with revocable parent-history grants for child-session hosts.
- A configurable fixed writer, bounded source chunks and accumulated writer usage.
- A restart-latched fallback switch and explicit-copy migration for complete original histories.

The [architecture](docs/context-memory/architecture.md) explains the host boundary and failure behavior. [Validation](docs/context-memory/validation.md) states what has actually been checked and what remains unproven.

The [changelog](CHANGELOG.md) separates released versions from changes on `main` that have not been released. The build instructions below check out the latest release tag and do not include those unreleased changes.

## Build from source

Requirements: Node.js 22.19 or newer, npm, Git, curl and tar. Persistent sessions currently support macOS and Linux.

```sh
git clone https://github.com/youxi-huang/pi-context-compaction.git
cd pi-context-compaction
git checkout v0.1.1
npm ci --ignore-scripts
node scripts/context-memory-model-data.mjs
node scripts/stamp-context-memory.mjs
npm run build:offline
node scripts/context-memory-check.mjs
```

The model-data helper downloads the pinned upstream source release, checks its SHA256 and extracts only the public model catalog required for the offline build. It does not read Pi configuration or call a model.

The focused check runs static checks and context-memory regressions. It does not run provider calls, browser smoke checks or the full upstream suite.

## Configure and run

Choose a writer model available through your own Pi authentication. The default is `openai-codex/gpt-6-astra` with `medium` effort. To override it, create `pi-context-memory.json` in your Pi agent directory (normally `~/.pi/agent/`):

```json
{
  "enabled": true,
  "writerModel": "openai-codex/gpt-6-astra",
  "writerEffort": "medium"
}
```

Authenticate providers through Pi's normal login or API-key configuration. This repository supplies no credentials. If the configured writer is unavailable, compaction stops and reports the problem; there is no silent model substitution.

Start with a fresh session:

```sh
node packages/coding-agent/dist/bundle/cli.js --no-extensions
```

`--no-extensions` disables ordinary extension discovery. The compaction extension is built into this host. Add trusted provider extensions explicitly with `-e` if your model needs one. The SDK is available from `packages/coding-agent/dist/index.js` after building.

Use `/compaction-status` to inspect the build, writer, checkpoint and request state. Set `enabled` to `false` and restart Pi to use default Pi compaction. `/reload` does not change this setting. Storage protections and the opaque-checkpoint migration guard remain active in fallback mode.

### Event log

Each compaction attempt, request guard, history retrieval and note candidate appends one line to `context-memory-events.jsonl` in the agent directory. Lines carry outcome, error class, durations, token counts, sizes and identifiers only. No message text, note content, quotes, queries, file paths or free-form error messages are written. Every session has a fixed quota per event kind, so a failure loop cannot grow the file, and the file rotates once at 8 MB. Set `"eventLog": false` in `pi-context-memory.json` to turn it off. Summarize the log with:

```sh
node scripts/context-memory-report.mjs
```

Other extensions may observe `session_before_compact` as long as their handlers return `undefined`; they run before the writer. An extension that returns a compaction or a cancellation from that event competes with this feature, and the compaction fails with `CONTEXT_COMPACTOR_CONFLICT` before the writer is called. Disable such compactors before use. This project does not overwrite a global Pi installation or migrate old sessions automatically.

## Data and compatibility

Notes, tool results and history can contain sensitive information. They remain in local session files, but relevant source content is sent to the writer during compaction and to the selected model when retrieved. History grants restrict this API; they are not an operating-system sandbox for agents with shell access.

Opaque checkpoints from older provider-specific compactors require a reviewed migration copy before resuming. Run `node scripts/context-memory-migrate.mjs --help` for the workflow. It cannot recover missing evidence or decrypt remote checkpoints.

This release contains the host and compaction modules. Locally adapted BTW, subagent and provider packages are not bundled. Integrators can use the exported `contextMemory` API; unmodified third-party packages should not be assumed compatible. Windows persistence, long-running semantic quality and repeated incremental-note comparisons are not validated.

The project was initially named Pi Context Memory. Existing `context-memory` source paths, the `pi-context-memory.json` configuration file, the `contextMemory` API and stored checkpoint identifiers retain their original names. The project rename does not require configuration or session migration.

## License and acknowledgments

MIT. Pi retains its original license and copyright. New context-memory code is covered by the same license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The design was inspired in part by OpenAI's public description of notes across context windows and retrieval of earlier task messages. Codex assisted development. This project is independently maintained and is not an official OpenAI or Pi release. No OpenAI context-management implementation has been copied. See [OpenAI's description](https://learn.chatgpt.com/docs/models).

The original Pi README is retained as [UPSTREAM_README.md](UPSTREAM_README.md). Its release and support instructions apply to upstream Pi, not this experimental distribution.
