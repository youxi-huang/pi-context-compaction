# Validation record

## Scope

The implementation was exercised with synthetic files and session records. No private transcripts, credentials or deployment configuration are included in this repository.

The public source removes an optional environment-specific content-policy adapter. The real run below used the same generic prompt without an optional policy. The public source is rebuilt and its focused regressions rerun separately. This record does not claim that all locally tested third-party integrations are included.

## Real provider scenario

One complete successful SDK scenario used Gemini 3.8 Flash for the main task and a fixed Astra writer at medium effort:

1. Read a synthetic decision record and bind diagnostic; change a service port from 9000 to 4317.
2. Commit the first note.
3. Receive a superseding instruction: port 4318 and timeout 9500. Update the file and commit another note.
4. Close and reopen the persisted session with Astra as the task model. Disable filesystem reads and retrieve the earlier diagnostic through `context_history`.
5. Verify current values, the rejected port, `EADDRINUSE`, the exact generated trace identifier and original entry IDs.
6. Ask a Gemini side question through a locally adapted BTW integration. Verify the answer and unchanged main-session hash and leaf.

The complete run passed. The task model never called `context_note`, exercising the boundary fallback. Runtime was about 91 seconds, including approximately 23.7 seconds per note. The successful run reported 40,037 total tokens, including 5,690 for the writer calls. These are provider usage records, not an invoice or comparative savings result.

Two earlier attempts stopped: one during OAuth response decoding before inference; one during the initial tool round when a metadata-only update triggered an overly strict timestamp check. Both causes were corrected before the successful run. The timestamp regression is included; the provider-specific transport patch is separate and not shipped.

## Focused regression coverage

### v0.2.1 reliability checks, 2026-09-09

The focused check passes 43 tests, including nine added cases for repeated compaction within one open tool turn, reopening, actual writer output budgets, failed and cancelled call accounting, and backward-compatible report totals. The relevant host context-assembly and compaction tests separately pass 40 tests, with two provider-dependent tests skipped. The security and compatibility script passes all 429 tests.

An isolated compiled SDK run used `openai-codex/gpt-6-astra` at medium effort for both task work and the session writer. Four manual checkpoints committed. One additional real writer response was deliberately replaced with invalid JSON: no checkpoint or session-file change was published, returned usage was logged, and an explicit retry succeeded. The open tool-turn records were seeded fixtures with actual local read results, not autonomous model-generated tool turns. Initial and resumed file edits and subsequent history retrieval were performed by the real model. Reopening recovered the latest ruling and completed the correct file update while preserving an unrelated file.

A separate probe forked from the fourth checkpoint, before the resumed task's answer could expose the values. It recovered the first and current approved ports, first and current timeouts, the originally rejected port and error code, both original user-entry IDs, and a verbatim still-valid restriction from the first user ruling. All four archived checkpoints and `priorCheckpoints` remained available. The probe's first local assertion incorrectly coerced a text-block array to a string; rechecking the same saved response with the runtime text extractor passed, without another model call. This checks recovery of one early constraint, not retention of arbitrary constraints over long sessions.

The five writer calls used 19,262 provider-reported tokens in total; the deliberately invalidated response accounted for 4,214. The four successful compactions took approximately 19.4–24.4 seconds each. These short, manually compacted fixtures test correctness and accounting, not token savings, automatic-threshold performance or near-window-limit behavior. Capacity boundaries and transport failures were tested synthetically. No native-compaction quality comparison was run.

A subsequent natural task set `compactAt` to 5% in an isolated configuration (52,500 tokens for the selected Astra model). The first run stopped at `CONTEXT_PAYLOAD_TOO_LARGE` before any writer call. It exposed two remaining defects: the trigger was also used as the final payload allowance, and automatic handover pinned the entire unfinished user turn. The fixes separate the actual model allowance from the trigger and let the default automatic handover cover completed tool batches through Pi's existing next-response hook.

On the corrected build, one user prompt caused the model to read nine synthetic deployment ledgers completely (18 paginated reads, 1,215 records), cross two automatic in-task checkpoints, retrieve original history and write the correct audit result. There were no manually triggered compactions or seeded assistant/tool messages. The model distinguished the initial and current approved values, the original bind failure and a later superseding decision, and obeyed the initial write restriction. Both checkpoints were followed by further tool work. Compaction events recorded approximately 55.2k → 2.0k and 58.1k → 2.7k estimated tokens; pauses were 54.4 and 72.3 seconds. This establishes functional continuation for this task, not unobtrusive latency or multi-day reliability. The 5% setting was not applied to the maintainer's normal configuration. Adaptive hard/soft scheduling remains future work.

Release dependency review found one moderate development-server advisory affecting three Vitest-related packages (`GHSA-82fw-gwwq-j7x9`). The production dependency audit reported no findings. This validation uses Node tests rather than an exposed mocker development server; updating the inherited test dependencies is separate maintenance. Existing reviewed CodeQL alerts are not claimed to be resolved by this release.

### Covered contracts

- First flush, append rollback, failed recovery and deferred forks.
- Concurrent writers and recovery of a crashed process lease.
- Child-scoped grants, tampered references, cross-process reads and revocation.
- Exact quotations, pagination, branch isolation and long source chunks.
- Resident filtering/reload, restart-latched settings, a passive `session_before_compact` observer and a second compactor whose result is rejected before the writer runs.
- Two checkpoints and reopening, failed compaction and request blocking.
- Cancelled/stale candidates, source changes and metadata-only updates.
- Event log: committed and failed attempts settled once with error classes, guards counted once per failure, history calls logged without content, per-session quotas surviving restart, rotation and the disable flag.

Run `node scripts/context-memory-check.mjs` after building. It combines focused tests with formatting, typing, dependency and entry-graph checks. CI repeats it on Linux with pinned model data. No provider credentials are needed.

## Host security regressions

Run `node scripts/security-regression-check.mjs` for the host changes reviewed on 2026-09-07. The same command is included in CI. It runs 429 tests across four groups (77 AI, 235 coding-agent, 6 agent and 111 TUI), covering provider URL classification and cache parameters, escaped OAuth errors, message-frame index validation, Git operand boundaries, package sources, prompt arguments, skill paths and LaTeX rendering. Pathological text inputs run in a child process with a timeout so a regular-expression regression cannot hang the test process indefinitely.

The checks use synthetic input and mocked providers; OAuth callback checks use a local loopback server. They do not make model requests. The 43 context-memory regressions remain a separate check. Passing these checks does not establish that every scanner alert is exploitable or resolved; remote CodeQL and dependency results must be checked on the pushed commit.

## Practical limits

This is one task-level recovery result, not proof of lossless memory. Repeated increment-versus-boundary A/B comparisons were not run. Long-running quality, maximum-window behavior, Windows persistence, terminal/RPC interaction and all third-party extensions have not been comprehensively tested. The full upstream suite and browser smoke checks are outside this validation record.

Use synthetic reproductions when reporting failures. Do not attach a complete real session to demonstrate a missing fact.
