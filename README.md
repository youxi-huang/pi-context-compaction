# Pi Context Compaction

Context compaction for [Pi](https://github.com/earendil-works/pi) that keeps the original transcript as the source of truth: notes cite the records they came from, and the model can read those records back after compaction.

| | |
| --- | --- |
| **Project type** | Experimental Pi distribution, built from source. Not a Pi package. It cannot be added to an unmodified Pi installation with `pi install`. |
| **Upstream baseline** | Pi `v0.85.1`, commit `d981de12`, imported as a clean snapshot. |
| **What is new** | One extension directory, seven adapted host files, project scripts, tests and docs. See [upstream delta](docs/context-memory/upstream-delta.md). |
| **Latest release** | `v0.2.1`, marked pre-release. The root `package.json` carries upstream workspace metadata and is not this project's version. |
| **Ordinary extension packaging** | Planned for 1.0, when the host changes are thin enough to submit upstream. See the [roadmap](docs/context-memory/roadmap.md). |

## The problem, and where this is going

A long coding session outlives its context window. When Pi compacts, everything that fell out of the window survives only as a summary, and the summary keeps what the summarizer judged important at that moment. A decision from the first hour, a constraint the user stated once, the tool output that showed why an approach failed: each is either in the summary or gone, and the model that continues cannot tell which. So it guesses, or it asks again, and the user finds out later which one it did.

This project changes what a compaction leaves behind.

```
Pi's native compaction

  original messages  ->  summary  ->  the summary is all that remains

This project

  original JSONL  ->  note citing entry IDs  ->  compacted context
        ^                                              |
        |                context_history               |
        +----------------------------------------------+
```

At compaction, the writer produces a structured note from the original session records. Every quotation in the note is checked verbatim against the record it cites, and every cited record must be on the current branch; a note that fails these checks is refused rather than committed. The original JSONL stays on disk as the history store. After compaction the model can search the branch and read the exact earlier message through `context_history`, including the entry IDs behind a decision. The note is an index over the transcript, not a replacement for it. After a second checkpoint the note also lists the most recent earlier checkpoints on the branch, each with a readable anchor entry and its opening state lines, so a phase the newest note no longer describes still has a search anchor.

The end state this is built toward is a session that runs for days, compacts many times, and never asks the user to repeat something already said. You come back the next morning, ask why the schema was changed, and the model reads yesterday's decision back from the record by entry ID instead of guessing from a summary. A model that checks the record when it is unsure instead of reconstructing it from a summary. A compaction that costs a few seconds and a small share of the window, so it stops being an event anyone notices. And a host patch thin enough that all of this ships as an ordinary Pi extension. The [roadmap](docs/context-memory/roadmap.md) states the four measurements that decide whether each release moves closer: how many probe questions a model still answers correctly after compaction, how long the pause takes, how many tokens the writer spends, and how many host lines remain changed.

What holds today is narrower than that, and the [validation record](docs/context-memory/validation.md) says exactly how much. The design has run end to end with real providers, including a two-checkpoint session; 43 context-memory regressions and 429 host security and compatibility regressions run in CI on every change; failure states are explicit and a failed compaction blocks the next request rather than substituting a weaker summary. Recovery quality has not yet been measured against Pi's native compaction. That comparison, on replayable sessions with probe questions, is the 0.3.0 milestone and is the number that will say whether the design earns its cost.

The scope is preserving task continuity when model context is compacted. History access follows the current session branch and explicit parent-history grants; this project does not provide a general cross-session memory or user-preference store. This repository includes the host changes needed for persistent writer leases, commit ordering and resident extension loading, which is why it is a distribution rather than a drop-in extension.

## What it provides

- A resident context extension that survives ordinary extension filtering and reload.
- Disk-before-memory checkpoint publication, cooperative writer leases and explicit failure states.
- Notes with validated source references and exact quotations; the original JSONL remains the history store.
- Branch-scoped search and paginated reads, with revocable parent-history grants for child-session hosts.
- A configurable fixed writer, bounded source chunks and accumulated writer usage.
- A restart-latched fallback switch and explicit-copy migration for complete original histories.

The [architecture](docs/context-memory/architecture.md) explains the host boundary and failure behavior. [Validation](docs/context-memory/validation.md) states what has actually been checked and what remains unproven. The [roadmap](docs/context-memory/roadmap.md) states the version policy, the four measurements and the planned minor releases.

The [changelog](CHANGELOG.md) separates released versions from changes on `main` that have not been released. The build instructions below check out the latest release tag and do not include those unreleased changes.

## Build from source

Requirements: Node.js 22.19 or newer, npm, Git, curl and tar. Persistent sessions currently support macOS and Linux.

```sh
git clone https://github.com/youxi-huang/pi-context-compaction.git
cd pi-context-compaction
git checkout v0.2.1
npm ci --ignore-scripts
node scripts/context-memory-model-data.mjs
node scripts/stamp-context-memory.mjs
npm run build:offline
node scripts/context-memory-check.mjs
```

The model-data helper downloads the pinned upstream source release, checks its SHA256 and extracts only the public model catalog required for the offline build. It does not read Pi configuration or call a model.

The focused check runs static checks and context-memory regressions. It does not run provider calls, browser smoke checks or the full upstream suite.

## Configure and run

By default the current session model writes the handover note itself: the request is the session's own provider context plus one closing instruction, so no second model, no extra authentication and no cold read of the history are needed. The request repeats the prefix Pi itself would send, so a provider's prompt cache can serve it, unless another extension rewrites the context on each request. After the checkpoint, model context holds the system prompt and the note only; the original messages stay in the session file and on screen and can be retrieved with `context_history`.

To change any of this, create `pi-context-memory.json` in your Pi agent directory (normally `~/.pi/agent/`). Every key is optional; the values below are the defaults:

```json
{
  "enabled": true,
  "writerModel": "session",
  "writerEffort": "medium",
  "keepRecentTokens": 0,
  "noteTokens": 3000,
  "eventLog": true
}
```

- `writerModel`: `"session"`, or a `provider/model` string such as `"openai-codex/gpt-6-astra"` to use a fixed writer that reads the raw records in chunks. A fixed writer that is missing from the model catalog or whose provider has no configured authentication is reported at session start (as a notification in the terminal UI, on stderr otherwise) and in `/compaction-status`; compaction then fails until the configuration names a reachable model or `"session"`. There is no silent model substitution in either direction.
- `writerEffort`: reasoning effort for a fixed writer; passed only to models that declare reasoning support. The `session` writer ignores it and reasons at the session's current thinking level, the way Pi's own summarizer does, so a session running at `high` writes its note at `high` and a session with thinking off writes without reasoning.
- `keepRecentTokens`: estimated original tokens kept in context after a checkpoint. `0` keeps nothing once the current turn is complete, or when an automatic in-task handover covers a completed tool batch. Manual compaction of an unfinished turn and overflow retries keep their user message and tool rounds. A positive value keeps whole recent turns up to that estimate, capped at half the compaction threshold.
- `noteTokens`: upper bound for the serialized note, capped at 15% of the compaction threshold; minimum `500`.
- `compactAt`: optional. Automatic compaction point as an integer token count (above 1) or a share of the context window (at or below 1). A value too small for the selected model fails with `CONTEXT_CAPACITY` when that model is selected. Without it the point is `min(model cap, 0.8 × window, window − output reserve)`. This is a trigger at an available compaction boundary; final request guards separately enforce `window − output reserve` so a low trigger does not cause premature input rejection.

Manual `/compact` works on any session that holds at least one complete turn, including short conversations.

Authenticate providers through Pi's normal login or API-key configuration. This repository supplies no credentials.

Start with a fresh session:

```sh
node packages/coding-agent/dist/bundle/cli.js --no-extensions
```

`--no-extensions` disables ordinary extension discovery. The compaction extension is built into this host. Add trusted provider extensions explicitly with `-e` if your model needs one. The SDK is available from `packages/coding-agent/dist/index.js` after building.

Use `/compaction-status` to inspect the build, writer, checkpoint and request state. Set `enabled` to `false` and restart Pi to use default Pi compaction. `/reload` does not change this setting. Storage protections and the opaque-checkpoint migration guard remain active in fallback mode.

### Event log

Each compaction attempt, request guard, history retrieval and note candidate appends one line to `context-memory-events.jsonl` in the agent directory. Lines carry outcome, error class, durations, token counts, sizes and identifiers only. No message text, note content, quotes, queries, file paths or free-form error messages are written. Every session has a fixed quota per event kind, so a failure loop cannot grow the file. When the file reaches 8 MB it is renamed to `.1`, replacing the previous generation, so the log occupies at most about 16 MB. Set `"eventLog": false` in `pi-context-memory.json` to turn it off; `"enabled": false` also turns it off. Summarize the log with:

```sh
node scripts/context-memory-report.mjs
```

The existing `tokens` fields describe committed compactions. `writerAttempts.all` and `writerAttempts.byOutcome` also include known usage from failed and aborted attempts. Calls without returned usage, and attempts without call metadata in older logs, are counted explicitly; their missing cost is not evidence of zero cost.

Other extensions may observe `session_before_compact` as long as their handlers return `undefined`; they run before the writer. An extension that returns a compaction or a cancellation from that event competes with this feature, and the compaction fails with `CONTEXT_COMPACTOR_CONFLICT` before the writer is called. Disable such compactors before use. This project does not overwrite a global Pi installation or migrate old sessions automatically.

## Data and compatibility

Notes, tool results and history can contain sensitive information. They remain in local session files, but relevant source content is sent to the writer during compaction and to the selected model when retrieved. History grants restrict this API; they are not an operating-system sandbox for agents with shell access.

Opaque checkpoints from older provider-specific compactors require a reviewed migration copy before resuming. Run `node scripts/context-memory-migrate.mjs --help` for the workflow. The script has no live session, so it needs a fixed `provider/model` writer in `pi-context-memory.json` for the run; with `"session"` it stops before any work. It cannot recover missing evidence or decrypt remote checkpoints.

This release contains the host and compaction modules. Locally adapted BTW, subagent and provider packages are not bundled. Integrators can use the exported `contextMemory` API; unmodified third-party packages should not be assumed compatible. Windows persistence, long-running semantic quality and repeated incremental-note comparisons are not validated.

The project was initially named Pi Context Memory. Existing `context-memory` source paths, the `pi-context-memory.json` configuration file, the `contextMemory` API and stored checkpoint identifiers retain their original names. The project rename does not require configuration or session migration.

## License and acknowledgments

MIT. Pi retains its original license and copyright. New context-memory code is covered by the same license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The design was inspired in part by OpenAI's public description of notes across context windows and retrieval of earlier task messages. Codex assisted development. This project is independently maintained and is not an official OpenAI or Pi release. No OpenAI context-management implementation has been copied. See [OpenAI's description](https://learn.chatgpt.com/docs/models).

The original Pi README is retained as [UPSTREAM_README.md](UPSTREAM_README.md). Its release and support instructions apply to upstream Pi, not this experimental distribution.
