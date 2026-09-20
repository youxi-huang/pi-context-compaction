# Configuration and operation

[Back to the project README](../../README.md#build-and-run). Commands below run from the repository root.

By default the current session model writes the handover note itself: the request is the session's own provider context plus one closing instruction, so no second model, no extra authentication and no cold read of the history are needed. The request repeats the prefix Pi itself would send, so a provider's prompt cache can serve it, unless another extension rewrites the context on each request. After the checkpoint, model context holds the system prompt and the note only; the original messages stay in the session file and on screen and can be retrieved with `context_history`.

To change any of this, create `pi-context-memory.json` in your Pi agent directory (normally `~/.pi/agent/`). Every key is optional; the values below are the defaults:

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

- `writerModel`: `"session"`, or a `provider/model` string such as `"openai-codex/gpt-6-astra"` to use a fixed writer that reads the raw records in chunks. A fixed writer that is missing from the model catalog or whose provider has no configured authentication is reported at session start (as a notification in the terminal UI, on stderr otherwise) and in `/compaction-status`; compaction then fails until the configuration names a reachable model or `"session"`. There is no silent model substitution in either direction.
- `writerEffort`: reasoning effort for a fixed writer; passed only to models that declare reasoning support. The `session` writer ignores it and reasons at the session's current thinking level, the way Pi's own summarizer does, so a session running at `high` writes its note at `high` and a session with thinking off writes without reasoning.
- `keepRecentTokens`: estimated original tokens kept in context after a checkpoint. `0` keeps nothing once the current turn is complete, or when an automatic in-task handover covers a completed tool batch. Manual compaction of an unfinished turn and overflow retries keep their user message and tool rounds. A positive value keeps whole recent turns up to that estimate, capped at half the compaction threshold.
- `noteTokens`: optional **fixed hard limit** for the serialized JSON note (minimum `500`), capped at 15% of the trigger and the storage maximum of `8000`. Explicit settings retain fixed-budget semantics. When omitted, the default is tiered: released-source estimates of up to 80k, 200k, 400k and above select base/hard allowances of 3000/4000, 4000/5000, 5000/6000 and 6000/8000. The previous note's actual size supplies a bounded anti-shrink floor; smaller windows take precedence. These are UTF-8 byte-based estimates, not provider token counts. See [budget rules](architecture.md#tiered-note-budgets-and-bounded-repair-v023).
- `noteRepair`: default `true`. Only an otherwise valid note exceeding its frozen hard limit gets at most one short, same-model size-repair call across the whole compaction. It adds paid usage and latency when needed. Set `false` for strict one-pass behavior. No model substitution, mechanical truncation or retry of other failure classes is introduced.
- `compactAt`: optional. Automatic compaction point as an integer token count (above 1) or a share of the context window (at or below 1). A value too small for the selected model fails with `CONTEXT_CAPACITY` when that model is selected. Without it the point is `min(model cap, 0.8 × window, window − output reserve)`. This is a trigger at an available compaction boundary; final request guards separately enforce `window − output reserve` so a low trigger does not cause premature input rejection.

Manual `/compact` works on any session that holds at least one complete turn, including short conversations.

Authenticate providers through Pi's normal login or API-key configuration. This repository supplies no credentials.

Start with a fresh session:

```sh
node packages/coding-agent/dist/bundle/cli.js --no-extensions
```

`--no-extensions` disables ordinary extension discovery. The compaction extension is built into this host. Add trusted provider extensions explicitly with `-e` if your model needs one. The SDK is available from `packages/coding-agent/dist/index.js` after building.

Use `/compaction-status` to inspect the build, writer, checkpoint, budget mode, repair setting, active/last attempt and request state. `budget.noteTokens` is the stable pending-candidate allowance, not a prediction of the next cut-dependent writer budget; `checkpointBudget` and attempt `budgetPolicy` are actual frozen decisions. Set `enabled` to `false` and restart Pi to use default Pi compaction. `/reload` does not change this setting. Storage protections and the opaque-checkpoint migration guard remain active in fallback mode.

### Event log

Each compaction attempt, request guard, history retrieval and note candidate appends one line to `context-memory-events.jsonl` in the agent directory. Lines carry outcome, error class, durations, token counts, sizes and identifiers only. No message text, note content, quotes, queries, file paths or free-form error messages are written. Every session has a fixed quota per event kind, so a failure loop cannot grow the file. When the file reaches 8 MB it is renamed to `.1`, replacing the previous generation, so the log occupies at most about 16 MB. Set `"eventLog": false` in `pi-context-memory.json` to turn it off; `"enabled": false` also turns it off. Summarize the log with:

```sh
node scripts/context-memory-report.mjs
```

The existing `tokens` fields describe committed compactions. JSON byte measurements and hard-budget occupancy are separate from rendered note, lineage and continuation sizes; old logs lacking these measurements are reported as unknown. Per-call generation/repair accounting and elastic usage make fallback cost visible. `writerAttempts.all` and `writerAttempts.byOutcome` also include known usage from failed and aborted attempts. Calls without returned usage, and attempts without call metadata in older logs, are counted explicitly; their missing cost is not evidence of zero cost.

Other extensions may observe `session_before_compact` as long as their handlers return `undefined`; they run before the writer. An extension that returns a compaction or a cancellation from that event competes with this feature, and the compaction fails with `CONTEXT_COMPACTOR_CONFLICT` before the writer is called. Disable such compactors before use. This project does not overwrite a global Pi installation or migrate old sessions automatically.
