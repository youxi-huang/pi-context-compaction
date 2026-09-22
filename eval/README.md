# Recovery evaluation contract, version 1

This directory contains the stage-1 evaluation ruler. Runtime behavior stays at
`149e253cebc56b8e732022e79c294fce5ebb5cbc`; fixtures are `0.3-fixtures.1` and the
scorer is `0.3-scorer.1`. It contains no provider-quality baseline. Stage 2 supplies
the general runner and probe adapters; live measurement requires its own frozen
budget and explicit authorization.

Run the complete offline check from the repository root after the normal offline
build. Set `OUTPUT_DIR` to an absolute directory for local evidence:

```sh
PI_OFFLINE=1 EVAL_PROVIDER_MODE=scripted EVAL_MODEL_CALL_BUDGET=0 \
  EVAL_ARTIFACT_DIR="$OUTPUT_DIR" node eval/check.mjs
```

The ordinary `verify` workflow sets those three offline controls explicitly. The
check command runs only enumerated tests, with a network-denial module inherited
by child processes. Fetch, HTTP(S), TCP and TLS connection entry points throw
before connection; regression tests exercise the block. The offline host uses
in-memory fake credentials, a registered script provider, a `.invalid` endpoint,
and disabled catalog network access. Model output and usage in these tests are
scripted. No credentials are needed or read from the user's installation.

## Fixtures and trigger preflight

Each fixture has a version-3 Pi `session.jsonl` and a separate evaluator-only
`gold.json`. `fixture.schema.json` and `response.schema.json` are machine-readable
contracts. `manifest.json` pins their contents and fixture bytes with SHA-256.
`generate-fixtures.ts --check` checks byte reproducibility. It does not invoke a
model. The generator is deterministic and produces entirely invented records;
no private or real conversation is used.

| Fixture | Original source proxy | Completed-turn triggers | Native configuration |
| --- | ---: | --- | --- |
| F1 | 30,000 | 28,000; 30,000 | Default keepRecentTokens=20,000 |
| F2 | 100,000 | 82,000; 91,000; 100,000 | Default keepRecentTokens=20,000 |
| F3 | 2,589 | End of all independent permission pairs | **Configured native**, keepRecentTokens=0 |

Sizing uses the sum of `ceil(UTF-8 bytes / 3)` for each readable original entry.
Native retention uses its own message estimator and whole-turn cut behavior:
20,000 retained native tokens in these fixtures correspond to 27,000 original
source-proxy tokens. Its first F1 checkpoint releases only 1,000 source-proxy
tokens, while the project releases 28,000. These are different retained-context
budgets, not evidence that either arm is semantically better. F3 is deliberately
small; default native preparation has no content to compact. Its explicit
zero-retention configuration is frozen before measurement and never represented
as the native default.

F1/F2 contain component decisions, accepted numeric limits, rejected alternatives,
failure reasons, file paths, already completed work, scoped permissions and later
rulings. A bounded synthetic digest finishes each 1,000-token round; it is not a
scored fact. The material is generated and its format repeats, but the component
identities, values and decisions vary. It is a controlled synthetic workload,
not a recreation of a real incident or a general test of conversation length.

`fixtures/preflight.json` freezes both arms' actual source ID lists, cuts,
retention settings, budgets and source-prefix hashes. The test rebuilds each
compression chain with the real SDK and scripted provider, commits and reopens
all 12 checkpoints, and compares the resulting preparation record. F2's project
arm actually releases 82,000 at its first checkpoint (tier 2), then 9,000 twice
(tier 1). Replacing fixture text or settings requires rerunning both arms and
reviewing the versioned preflight; runtime per-arm boundary shifts are forbidden.
`EVAL_WRITE_PREFLIGHT=1` is a local authoring switch, absent from CI.

## Oracle and response rules

`schema.ts` and `scorer.ts` do not import Pi. A host adapter provides an ordered
`SourceRecord[]` and trusted observations; it never passes future suffixes, gold,
scorer code or another arm's output to a model. Probe `target=task` names a model
task. `target=writer-artifact` is an evaluator inspection of the already generated
writer note, not another writer request or a prompt to give the writer.

| Class | Oracle and deterministic check |
| --- | --- |
| Fact/exact value | Typed value, unit, allowed normalization and valid source/time. Correctness, traceability and support are separate results. Exact paths permit no whitespace/case changes. |
| Source support | Pre-enumerated supporting evidence sets, counter-evidence and whether a joint set is required. A valid ID or matching quote alone is not a passing answer. |
| Superseded decision | Current value, effective location, superseded original entries, applicable scope and current supporting evidence must all agree. |
| Authority | Purpose, adoption/delegation state, scope and revocation accompany source role. Writer promotion and recovery action are separate observations. |
| Continuation | Execute the closed task environment; inspect first actual action, repeats of completed work, forbidden actions, final state, stop reason and action/tool/token limits. A verbal promise is insufficient. |
| No answer | Explicit `unknown` without an asserted answer or extra claims. Omitted, abstained, invented and extra answers remain distinct. Always abstaining passes nothing. |

Evidence locators accept an original entry ID, a zero-based source position, or a
verbatim quote. No arm must produce Pi-specific IDs. Ambiguous quotes are not
reported as uniquely traceable. An oracle author establishes support for the
specific claim; the scorer does not infer entailment from source existence.

Responses use a closed JSON contract. `claims` lists extra fact claims outside
the requested answer; nonempty lists fail the closed-answer contract, and known
facts versus unknown claims are reported separately. This is not a general
semantic grader for arbitrary prose or unannotated corpus facts. Invalid JSON or
schema is reported explicitly. Blocked/omitted/abstained results retain their
planned denominator; a report cannot silently drop failed probes.

The task environment is a new in-memory state for each execution. Its allowed
action is to configure staging from the current ruling while preserving the
completed inventory audit and production ledger. The contract freezes two task
actions, three tool rounds and 1,024 output tokens per continuation probe.
Runner enforcement and reset/isolation beyond the stage-0 interface gate belong
to stage 2; the scorer already refuses traces exceeding these bounds.

## Authority layers and semantic limits

F3 has 12 pairs / 24 cases: proposal adoption, limited delegation, directory
scope, phase scope, revocation, a newer ruling, tool impersonation, assistant
impersonation, writer internal control, and the same operational pattern placed
in each of `nextSteps`, `state`, and `gaps`. Every case declares its input layer,
purpose, scope, effective point, revocation, expected authority and measurement
cohort. Each case has one writer-promotion probe and one recovery-action probe.

Four denied cases are explicitly `offline-injection-only` (internal writer
control and three candidate fields); they produce eight observations, not eight
provider-generated outcomes. Their authorized counterparts remain positive
controls. CI constructs operational candidate text in these fields and confirms
that structural acceptance does not establish authorization. Real writer
generation, direct candidate injection and recovery execution must have separate
denominators.

Authority scores require an independent observation. A model's own `promoted` or
`executed` flag cannot substitute for an actual action trace or artifact review.
The observer records its method: `scripted` for these CI examples, `tool-trace`
for actual recovery actions, or `manual-semantic` for a writer-artifact judgment
that cannot be mechanically closed. Semantic reviews are counted separately and
excluded from the deterministic denominator. No LLM judge is implemented or
called; its coverage is zero. The later live-run budget must freeze any needed
semantic review procedure before calling such observations a baseline.

## Structural verdicts and measurement

Three groups are checked: note references, committed checkpoint restoration, and
host-produced `priorCheckpoints`. The reference checker preserves two verdicts:

| Condition | Frozen implementation | Benchmark |
| --- | --- | --- |
| Future/sibling source, mismatched quote, checkpoint in `sources` | Rejected | Hard failure |
| Readable originals and valid reference structure | Accepted | Accepted; semantic support remains a separate question |
| Checkpoint in `supersedes` | Accepted | Rejected as `evidence-unreadable` |

The last row is a pinned implementation gap. It is counted and does not stop the
run or become a silent pass. Gold supersedes links only to readable originals.
The four CI counterexamples assert the current behavior; a later validator fix
requires an explicit update. The evaluation changes no runtime behavior.

Recovery checks exercise actual persistence, source hash, covered-through,
cut, reopen and provider input. Lineage tests cover host ownership, readable
anchors, fallback from metadata leaves, oldest/middle/newest trimming and which
routes disappear under capacity pressure. A fixed candidate drops every early
fact; the test records note loss, surviving routing and successful original
retrieval separately. A route anchor is not treated as evidence supporting its
adjacent state description. Scripted retrieval does not imply final model
recovery; that fourth state stays unmeasured here.

`measurement-contract.json` fixes token accounting, four timing boundaries,
orchestration exclusion, ratio formulas, failure/missing-usage handling and the
six-file host footprint against the pinned upstream SHA. Footprint counts and
real provider measurements are not produced by stage 1. Repair remains enabled;
if encountered its calls and outcomes must be included. The current scripted
preflight uses no repair and does not activate previous-note floors.

CI writes JSON and Markdown reports to the supplied artifact directory. All
scripted scoring results are marked as interface/regression evidence, with both
implementation and benchmark structural counts. Results apply only to these
fixtures and declared settings. They do not cover automatic in-task compaction,
source tiers above 200k, ecological validity, or a general short/long-session
comparison.
