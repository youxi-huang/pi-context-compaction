# Configuration and operation

[Back to the project README](../../README.md#for-maintainers-and-contributors). Commands below run from the repository root.

Two implementations read the same `pi-context-memory.json` file in Pi's agent directory (normally `~/.pi/agent/`):

- The **stock-Pi preview** is the ordinary Pi package installed with `pi install`. It compacts only on request and uses a subset of the settings. Its scope and recovery rules are in [the preview guide](extension-preview.md).
- The **resident build** is the v0.3.0 source build with six host changes, kept for development and comparison. Everything else on this page, from [Resident build](#resident-build) on, describes it.

## Settings

Every key is optional; the values below are the defaults:

```json
{
  "enabled": true,
  "writerModel": "session",
  "writerEffort": "medium",
  "keepRecentTokens": 0,
  "noteRepair": true,
  "eventLog": true
}
```

| Key | Stock-Pi preview | Resident build |
| --- | --- | --- |
| `enabled` | `false` ends the package's protection after a restart; Pi's own compaction applies. | `false` restores default Pi compaction after a restart. |
| `writerModel`, `writerEffort` | Used as described below. | Used as described below. |
| `keepRecentTokens` | Used for the manual checkpoint. | Used for manual and automatic checkpoints. |
| `noteTokens`, `noteRepair` | Used as described below. | Used as described below. |
| `compactAt` | Bounds the checkpoint budget only. Pi's own threshold, after a completed turn, decides when the preview compacts automatically. | Sets the automatic compaction point. |
| `eventLog` | Not provided; the preview writes no event log. | Writes `context-memory-events.jsonl`. |

- `writerModel`: `"session"`, or a `provider/model` string such as `"openai-codex/gpt-6-astra"` to use a fixed writer that reads the raw records in chunks. A fixed writer that is missing from the model catalog or whose provider has no configured authentication is reported at session start (as a notification in the terminal UI, on stderr otherwise) and in `/compaction-status`; compaction then fails until the configuration names a reachable model or `"session"`. There is no silent model substitution in either direction.
- `writerEffort`: reasoning effort for a fixed writer; passed only to models that declare reasoning support. The `session` writer ignores it and reasons at the session's current thinking level, the way Pi's own summarizer does, so a session running at `high` writes its note at `high` and a session with thinking off writes without reasoning.
- `keepRecentTokens`: estimated original tokens kept in context after a checkpoint. `0` keeps nothing once the current turn is complete, or when an automatic in-task handover covers a completed tool batch. Manual compaction of an unfinished turn and overflow retries keep their user message and tool rounds. A positive value keeps whole recent turns up to that estimate, capped at half the compaction threshold. This is the extension's own setting; Pi's `compaction.keepRecentTokens` in Pi's `settings.json` is separate (see below).
- `noteTokens`: optional **fixed hard limit** for the serialized JSON note (minimum `500`), capped at 15% of the trigger and the storage maximum of `8000`. Explicit settings retain fixed-budget semantics. When omitted, the default is tiered: released-source estimates of up to 80k, 200k, 400k and above select base/hard allowances of 3000/4000, 4000/5000, 5000/6000 and 6000/8000. The previous note's actual size supplies a bounded anti-shrink floor; smaller windows take precedence. These are UTF-8 byte-based estimates, not provider token counts. See [budget rules](architecture.md#tiered-note-budgets-and-bounded-repair-v023).
- `noteRepair`: default `true`. Only an otherwise valid note exceeding its frozen hard limit gets at most one short, same-model size-repair call across the whole compaction. It adds paid usage and latency when needed. Set `false` for strict one-pass behavior. No model substitution, mechanical truncation or retry of other failure classes is introduced.
- `compactAt`: optional. Automatic compaction point as an integer token count (above 1) or a share of the context window (at or below 1). A value too small for the selected model fails with `CONTEXT_CAPACITY` when that model is selected. Without it the point is `min(model cap, 0.8 × window, window − output reserve)`. This is a trigger at an available compaction boundary; final request guards separately enforce `window − output reserve` so a low trigger does not cause premature input rejection. The stock-Pi preview guards requests on Pi's own estimate against Pi's threshold, `window − 16,384`, whatever the model's output maximum, so it never stops a request Pi would still send before compacting.

Configuration is read once per process. Restart Pi after changing it; `/reload` does not change it.

By default the current session model writes the handover note itself: the request is the session's own provider context plus one closing instruction, so no second model, no extra authentication and no cold read of the history are needed. The request repeats the prefix Pi itself would send, so a provider's prompt cache can serve it, unless another extension rewrites the context on each request. After the checkpoint, model context holds the system prompt and the note only; the original messages stay in the session file and on screen and can be retrieved with `context_history`.

Authenticate providers through Pi's normal login or API-key configuration. This repository supplies no credentials.

## When `/compact` can run

In the **stock-Pi preview**, Pi decides first. It keeps its own recent-history budget, `compaction.keepRecentTokens` in Pi's settings (20,000 estimated tokens by default), and answers `Nothing to compact (session too small)` until there is older history to summarize. The extension is not called in that case and records nothing. A short session therefore cannot be compacted after one turn with default Pi settings.

In the **resident build**, the host hands manual compaction to the extension, so `/compact` works on any session that holds at least one complete turn, including short conversations.

## Resident build

Start a fresh session with the built host:

```sh
node packages/coding-agent/dist/bundle/cli.js --no-extensions
```

`--no-extensions` disables ordinary extension discovery. The compaction extension is built into this host. Add trusted provider extensions explicitly with `-e` if your model needs one. The SDK is available from `packages/coding-agent/dist/index.js` after building.

Use `/compaction-status` to inspect the build, writer, checkpoint, budget mode, repair setting, active/last attempt and request state. `budget.noteTokens` is the stable pending-candidate allowance, not a prediction of the next cut-dependent writer budget; `checkpointBudget` and attempt `budgetPolicy` are actual frozen decisions. Set `enabled` to `false` and restart Pi to use default Pi compaction. Storage protections and the opaque-checkpoint migration guard remain active in fallback mode.

### Event log

The resident build appends one line to `context-memory-events.jsonl` in the agent directory for each compaction attempt, request guard, history retrieval and note candidate. Lines carry outcome, error class, durations, token counts, sizes and identifiers only. No message text, note content, quotes, queries, file paths or free-form error messages are written. Every session has a fixed quota per event kind, so a failure loop cannot grow the file. When the file reaches 8 MB it is renamed to `.1`, replacing the previous generation, so the log occupies at most about 16 MB. Set `"eventLog": false` in `pi-context-memory.json` to turn it off; `"enabled": false` also turns it off. Summarize the log with:

```sh
node scripts/context-memory-report.mjs
```

The existing `tokens` fields describe committed compactions. JSON byte measurements and hard-budget occupancy are separate from rendered note, lineage and continuation sizes; old logs lacking these measurements are reported as unknown. Per-call generation/repair accounting and elastic usage make fallback cost visible. `writerAttempts.all` and `writerAttempts.byOutcome` also include known usage from failed and aborted attempts. Calls without returned usage, and attempts without call metadata in older logs, are counted explicitly; their missing cost is not evidence of zero cost.

### Other compactors

Other extensions may observe `session_before_compact` as long as their handlers return `undefined`; they run before the writer. An extension that returns a compaction or a cancellation from that event competes with this feature, and the compaction fails with `CONTEXT_COMPACTOR_CONFLICT` before the writer is called. Disable such compactors before use. This project does not overwrite a global Pi installation or migrate old sessions automatically.

### Compatibility notes

Opaque checkpoints from older provider-specific compactors require a reviewed migration copy before resuming. Run `node scripts/context-memory-migrate.mjs --help` for the workflow. The script has no live session, so it needs a fixed `provider/model` writer in `pi-context-memory.json` for the run; with `"session"` it stops before any work. It cannot recover missing evidence or decrypt remote checkpoints.

v0.3.0 reads existing valid checkpoints without rewriting them and preserves transcript prompt/tool state through compaction and reopening. Custom providers and extensions must target Pi v1.1.0; update them before using them with this release. A provider still reading legacy `context.systemPrompt` or `context.tools` may silently omit instructions or tools. Pi 1.x virtual models must declare a context window, or the session stops with `CONTEXT_CAPACITY`. The built-in MCP, codemode and tool-search extensions have not been validated alongside the compaction resident.

The v0.2.3 note-budget behavior remains unchanged. New checkpoints carry a bounded budget decision so publication and reopening agree even above 6,000 estimated tokens; lowering generation settings does not invalidate stored notes. **Older binaries cannot read new notes above their 6,000-token limit.** Keep those sessions on v0.2.3 or newer; a binary rollback is not a session-format downgrade. A changed model still must fit the final recovery payload.

The resident source build contains the host and compaction modules. Locally adapted BTW, subagent and provider packages are not bundled. Integrators can use the exported `contextMemory` API; unmodified third-party packages should not be assumed compatible. Windows persistence, long-running semantic quality and repeated incremental-note comparisons are not validated.

Notes, tool results and history can contain sensitive information. They remain in local session files, but relevant source content is sent to the writer during compaction and to the selected model when retrieved. History grants restrict this API; they are not an operating-system sandbox for agents with shell access.
