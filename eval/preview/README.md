# Preview evaluation set (0.5.0)

This directory measures the independent preview, the package that runs on official Pi. It is separate from the
frozen F1 to F3 fixtures in `eval/fixtures`, which evaluate the resident runtime pinned in `eval/runtime.ts`; nothing
here changes those fixtures, their scorer or the pin. See the [0.5.0 plan](../../docs/context-memory/v0.5.0-plan.md),
work packages W0 and W3.

## Fixtures

`generate.ts` writes three invented Pi version-3 sessions and their gold files; `--check` regenerates them in memory
and fails on any byte difference. `fixtures/manifest.json` pins every file by SHA-256.

| Fixture | Source tokens | Checkpoints | What it stresses |
| --- | ---: | ---: | --- |
| P1 | about 70,000 | 3 | A timeout revised three times and reverted; a withdrawn subtask; a failed approach the user forbids retrying; a user ruling echoed verbatim by the assistant and inside a tool output; a deploy instruction that only a log line gives |
| P2 | about 51,000 | 2 | Decisions and errors among long tool outputs; a corrected threshold and due date; a file the user forbids creating |
| P3 | about 44,000 | 3 | Answers a note cannot hold: exact values among 400 endpoint latencies, 200 audited packages and 900 log lines; twelve edit and write calls and four failed tool calls to count and tell apart; a timeout raised for every service and then restored for one |

P1 and P2 test what a note keeps; with no tools, the notes alone answered nearly all their probes in the first
provider run. P3 tests retrieval: most of its answers are exact values or inventories that only `context_history`
can recover, so the gap between the two probe conditions and the calls per question are its measures.

Source tokens are `ceil(UTF-8 bytes / 3)` of the readable text, the preview's own size proxy. Each checkpoint
follows a completed assistant turn. Every tool call has exactly one result.

The 75 probes each ask for one JSON answer: `{"status":"answer","value":...,"evidence":[...]}` or
`{"status":"unknown"}`. Values are numbers, booleans, short text with listed accepted forms, or an option letter.
Probe kinds (current and previous values, counts, constraints, forbidden retries, withdrawn work, attribution,
authority, absent answers, continuation and facts) live only in the gold files. A test keeps them out of every
prompt, and the runner passes no category to the runtime.

## Scoring

`scorer.ts` reports, with denominators, correct, incorrect, abstained, `unknown-correct`, fabricated (an answer
where the records hold none), invalid (no answer object) and blocked (no reply, for example after a refused
checkpoint). It also counts answers whose evidence cites an accepted entry, and evidence IDs that do not exist. It
reports by kind and separately for answers whose source crossed an earlier compaction.

Scorer version 2 (`0.5-preview-scorer.2`) measures what the answer says, not how it is phrased. A value that leads
with the expected answer and goes on in prose passes, such as "No. The endpoint was disabled." for `false` or "JSON
lines (JSONL), not CSV" for a format; the answer must end at a character that cannot continue a word, so "Nope" or
"2500" do not pass for "no" or 250. Such answers are counted under `prose`. Version 1 failed them: in the first
provider run, nine answers with the right value were scored incorrect. The answer contract is unchanged, so runs on
either side of the change ask the same questions.

`rescore.ts` scores the replies a bench run saved with the current scorer, so a run made under an earlier version
can be compared on equal terms:

```sh
node --experimental-strip-types eval/preview/rescore.ts "$OUTPUT_DIR/candidate-probes"
```

## Runner

`scripts/context-memory-preview-bench.mjs` loads a built preview package into an official Pi installation and runs
each unit in its own process and agent directory. It needs the package and host from the preview build:

```sh
node scripts/context-memory-ops.mjs preview   # builds .artifacts/context-memory-preview-package and installs Pi
node --experimental-strip-types scripts/context-memory-preview-bench.mjs \
  --package-dir .artifacts/context-memory-preview-package \
  --stock-root .artifacts/context-memory-preview-stock \
  --output-dir "$OUTPUT_DIR" --mode writer --attempts 2
```

| Mode | What it does |
| --- | --- |
| `smoke` | One small request over P1's opening turn, to check that the provider accepts the generated history |
| `writer` | For each checkpoint, earlier cuts are compacted by a loopback writer that builds faithful notes from the gold files; the measured writer then compacts the cut on `--attempts` fresh copies. Reports refusals by code and quotation class, repairs, writer calls, usage and pause. For each committed note it also reports its size against the bytes it condenses (the previous note and every later message) and how many gold answers it cites, split into answers first asked at this cut and answers carried from earlier cuts |
| `probes` | The measured writer compacts each fixture cut after cut; a refused cut is retried, as a user retries `/compact`, up to `--chain-attempts` attempts in all (default 4), so that recall is measured on committed notes while `writer` mode measures refusals. A cut still refused blocks its probes and every later one. Each probe runs on its own copy of the chain at its checkpoint, once with only `context_history` active and once with no tools. Reports scores per condition, `context_history` calls per question by operation, and missed-entry probes, whose answers sit in entries no checkpoint cites |

`--provider loopback`, the default, answers locally and never contacts a model service; it checks the harness.
`--provider deepseek` uses Pi's catalog model `deepseek/deepseek-flash` through the environment's network proxy,
which supplies the key; Pi receives only a placeholder. A provider run requires `--max-requests`, `--max-minutes` and
`--max-cost-usd` and starts no unit once any limit is reached; with `--concurrency N`, up to N units already running
may finish past it. Costs are Pi's catalog estimates, not invoices. The limits go to the maintainer before the first
request:

```sh
node --experimental-strip-types scripts/context-memory-preview-bench.mjs \
  --package-dir .artifacts/context-memory-preview-package \
  --stock-root .artifacts/context-memory-preview-stock \
  --output-dir "$OUTPUT_DIR" --label candidate-writer --mode writer --provider deepseek \
  --concurrency 6 --max-requests 50 --max-minutes 20 --max-cost-usd 0.5
```

### Prompt cache

In daily use the session's prefix stays cached: every main-model turn sends the same system prompt, tools and
history. The session writer reuses all three and sets no tool choice, as the session does, so it continues that cache.
Before `a2c62fa` it sent `tool_choice: "none"`, with which DeepSeek leaves the tools out of the prompt, and its
prefix ended after the system prompt (see the validation record). The bench reproduces a session's cache state by
default with `--cache warm`, so writer cost and pause are what a session pays. The units of a run share one working directory, and before each cut's compactions one
request with the session's own tools goes over the same history, as the session's last turn would. Each warm-up is
a cold request of its own, one per cut in both modes: budget eight more requests for a run over P1, P2 and P3.
`summary.json` reports them apart under `used.warmups` and `used.warmupCostUsd`. Runs with different labels use
different directories, so one run never warms another and builds compare on equal terms.

`--cache cold` gives every unit its own working directory. Pi's system prompt ends with it, so only the prompt's
opening is shared and the writer pays for the whole history on every attempt. It reproduces the first 0.5.0
provider run, whose writer cost and pause were measured this way. The cache does not change what the model writes,
so refusals, note sizes and probe scores compare across both settings; cost and pause do not.

The run directory holds `summary.json`, per-unit rows without note text (`writer.jsonl`, `compactions.jsonl`,
`probes.jsonl`) and `answers.jsonl` with the synthetic probe replies. Keep it outside the repository.
