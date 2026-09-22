# Runner and visibility contract

`runEvaluation()` executes one fixture × arm × replicate. `runPlan()` schedules
sequential pairs, alternating which arm goes first across fixtures/replicates.
Every run rebuilds its complete compression chain from the frozen JSONL. Notes
are never borrowed from a prior replicate and failed samples are never replaced.

This stage exposes only a **scripted transport**. It makes no real provider
calls. The request interface carries the model, reasoning setting, actual SDK
context, remaining output limit and abort signal so an explicitly authorized
provider binding can be added after the live budget is frozen. There is no live
CLI flag or credential lookup. A selected model and thinking level may be tested
with the script interface; they are recorded in requests and reports. The
compactor continues to use its existing session writer, default repair and
unchanged host code.

From the repository root, after the normal offline build:

```sh
PI_OFFLINE=1 EVAL_PROVIDER_MODE=scripted EVAL_MODEL_CALL_BUDGET=0 \
  node --experimental-strip-types --import ./eval/deny-network.mjs \
  eval/runner/cli.ts F1 project 1 "$OUTPUT_DIR"
```

`OUTPUT_DIR` must be an absolute evaluator artifact directory. Each execution
gets a new run directory. `run.json`, `run.md` and `scores.json` contain the
terminal result and full denominators. CLI exit 0 means the planned execution
finished without blocked observations, not that recovery answers were correct.
The default script intentionally abstains. F3 requires evaluator writer review
for original-message artifact probes; without a reviewer those observations are
explicitly blocked and CLI exits 2.

The runner checks runtime source against `149e253cebc56b8e732022e79c294fce5ebb5cbc`
and the frozen fixture/schema/scorer files against
`87f707e9d06da0a9eaac4854a91423ef1c04cf1f`, including unexpected untracked files
within those paths. It also verifies the fixture manifest. Its own version and
source hash are recorded. A changed input is rejected before execution; changing
the pin requires explicit review and a new preflight.

## What each participant can see

| Participant | Visible inputs | Excluded inputs |
| --- | --- | --- |
| Evaluator | Full fixture, gold, scorer, all arm results, budget/trace files | None within the declared evaluation |
| Writer | The host's actual writer request for this arm and boundary, including the current prefix and previous note | Gold, future suffix, probes, another arm's output |
| Task transport/model | Reopened checkpoint context, this task prompt and returned tool results | Gold/oracle, evaluator rubric, future suffix, previous probe answers, another arm's output |
| Writer reviewer | Cloned evaluator data and the actual note/summary | Cannot mutate the runner's gold by modifying callback arguments |

Only `target=task` probes become task requests. Writer-artifact probes inspect an
already generated note; their evaluator prompt is never sent to the writer.
Input objects crossing into the transport are deep copies and contain no fixture
or reviewer callback. Independent model calls receive the current explicit
context; no response/thread identifiers or previous-probe conversation are reused.

For every probe, the runner copies only the committed boundary prefix. All
original entry IDs and parent links remain intact. Each copy has a new session
identity, work directory, host configuration and in-memory tool state. The chain
continues from the clean checkpoint, never from a probe's modified session.
Snapshot bytes are checked again after probes. Later source increments join the
real checkpoint ancestor while retaining original source IDs.

The native arm uses the same pinned host with the resident disabled: F1/F2 keep
the default 20,000; F3 retains its declared configured-native budget of zero.
Triggers are always the frozen completed-turn boundaries. The host computes and
records its actual cut from that run's history and preceding note; the runner
never moves an individual arm's trigger or silently changes retention settings.
An in-probe automatic compaction attempt is refused as an undeclared boundary.

## Tools and actions

Task tools are `read`, `write`, and `task_action`; only the project arm also has
`context_history`. No bash, edit, directory inventory, external extension or
`context_note` tool is available. File contents come from a capability-limited
in-memory map: `task.json` is read-only and `scratch.txt` is writable. Outside
paths are rejected before ordinary read-tool path metadata checks, and neither
tool reads or writes real file contents. Absolute paths, traversal and attempts
to name evaluator/other-arm files confer no access. History grants are rejected
before the history tool can expand the branch scope.

`task_action` changes only the synthetic world. It receives the public initial
state, not the oracle goal or permitted-answer list. Wrong in-world values are
recorded without revealing the correct value through validation errors. The
evaluator later scores the trace against frozen constraints. Out-of-scope real
file access remains mechanically denied. This is a tool capability boundary,
not a claim to sandbox arbitrary untrusted native plugins or transport code.

The trace distinguishes the first actual tool call from the first task mutation.
Read/history calls count toward tool rounds; task actions and scratch writes
count toward the mutation limit. Both traces and the actual final state are
retained. A verbal promise to act cannot become a task action. Permission probes
observe actual execution; unrelated extra mutations cannot be used to obtain a
passing permission score.

## Enforcement and termination

Continuation limits are read directly from the frozen oracle: **two mutations,
three tool rounds, 1,024 cumulative output tokens**. Other task probes currently
use those same conservative defaults. A tool round is one assistant response
containing tool calls, including parallel calls. Every mutation in a batch
reserves its own action slot before changing state. A third mutation cannot land;
a fourth tool round is rejected before its tools execute. The model gets at most
four calls, allowing a final answer after three tool rounds.

Before each task request, `maxTokens` is reduced to the remaining output budget
and the model's limit. Returned usage is accumulated. Missing/zero usage for a
nonempty response blocks the probe; it is not interpreted as free output.
Over-limit or truncated responses are retained as failed call evidence and do
not execute their tools. A provider that exceeds the requested cap can already
have spent tokens remotely; known overrun usage is reported rather than hidden.
Real provider adherence still needs live acceptance.

Each request has a timeout and abort signal. Run and plan call/time budgets are
checked before starting more work. Exhausted plans record unstarted samples and
`incomplete-budget`; failed compression blocks the remaining chain with an
explicit terminal reason. There are no hidden retries. Call records retain raw
returned usage, including failed responses, or null plus a missing-usage count.
Writer, task, and provider requests following retrieval are reported separately.

Pause records distinguish trigger, commit, recovery dispatch and next actual
task request. Copy/setup and evaluator delays are orchestration time, excluded
from product pause while still recorded. Task probes run before artifact review
so evaluator review time does not delay the first recovery request. All current
timings and usage are scripted interface observations, not live cost/latency.

## Authority injection and review

The frozen eight injection-only observations remain a separate cohort. For
those probes only, a private copy receives the declared operational claim in
the selected field (or the corresponding native summary section); this is
explicit candidate injection, not a newly generated writer output. The original
checkpoint remains unchanged. Structural validation still runs on reopen.

Original-message writer promotion requires a `writerReviewer`. Its method is
recorded as scripted or manual-semantic, and semantic scores stay outside the
deterministic denominator. Missing review is blocked, not silently safe. A live
semantic review protocol and any judge budget must be frozen in the live stage.

The CI runner tests include positive continuation, over-limit batch behavior,
future-original reads, full-suffix file access, gold canaries, cross-copy writes,
other-arm reads/writes, traversal, history grants, probe state resets, replicate
rebuilds, writer failure, missing usage, request timeout, model configuration,
reviewer isolation and paired-plan budget exhaustion. Fixture and probe files
remain unchanged from the accepted stage-1 commit.
