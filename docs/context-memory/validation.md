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

Run `node scripts/security-regression-check.mjs` for the host changes reviewed on 2026-09-07. The same command is included in CI. It runs 429 focused tests covering provider URL classification and cache parameters, escaped OAuth errors, message-frame index validation, Git operand boundaries, package sources, prompt arguments, skill paths and LaTeX rendering. Pathological text inputs run in a child process with a timeout so a regular-expression regression cannot hang the test process indefinitely.

The checks use synthetic input and mocked providers; OAuth callback checks use a local loopback server. They do not make model requests. The 28 context-memory regressions remain a separate check. Passing these checks does not establish that every scanner alert is exploitable or resolved; remote CodeQL and dependency results must be checked on the pushed commit.

## Practical limits

This is one task-level recovery result, not proof of lossless memory. Repeated increment-versus-boundary A/B comparisons were not run. Long-running quality, maximum-window behavior, Windows persistence, terminal/RPC interaction and all third-party extensions have not been comprehensively tested. The full upstream suite and browser smoke checks are outside this validation record.

Use synthetic reproductions when reporting failures. Do not attach a complete real session to demonstrate a missing fact.
