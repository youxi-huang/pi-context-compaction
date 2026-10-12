# Validation record

## Unreleased preview candidate: sessions it does not protect, 2026-10-12 UTC

The candidate `stock-preview+src.9ca9dd2123d49293` (working tree after v0.3.2,
package version string still 0.3.2) was tested on official npm Pi 1.1.0, with
Pi 1.0.4 only for the other-version case. All services were synthetic and
loopback; no real provider was contacted. It is not a release.

| Command | Result |
| --- | --- |
| `node scripts/context-memory-ops.mjs verify` | Exit 0: 163 focused checks (94 resident and 69 preview) and 461 host security checks. The resident fingerprint is unchanged. |
| `node scripts/context-memory-preview-build.mjs` | Exit 0: five package files, no host runtime. The bundle adds one preview source file (`notices.ts`); `dist/extension.js` grows from 87 KB to 108 KB. |
| `node scripts/context-memory-preview-acceptance.mjs` | Exit 0: 27 of 27, run from a temporary copy outside any Node project. The new case checks that `/compaction-doctor` and `/compaction-status` send no request and write no marker; removal uses the repository source without a ref. |
| `node scripts/context-memory-preview-scenarios.mjs` with both official installations | Exit 0: 125 passed, 2 known gaps, no failures, no unexpectedly passing gaps, no skips; all 18 control checks behaved as stock Pi. |
| `node --test scripts/context-memory-preview-release-checks.test.mjs` | Exit 0: 4 of 4. |
| `node scripts/context-memory-ops.mjs eval --full` | Exit 0: 89 of 89 offline evaluator tests; the frozen-input gate did not trigger. |

`preview --prepare` was not run: it requires a clean committed checkout.

Fifteen of the 17 known gaps listed for v0.3.2 are now required checks. Sessions
on Pi 1.0.4, in-memory sessions, sessions with a native checkpoint and sessions
with an image keep working with no failure marker, and `/compact` in them is left
to Pi. Threshold cancellation, a failed compaction and each blocked input show one
notice. New required checks cover an unreadable configuration (requests stop, no
marker, usable after the fix and a restart), an image in a protected session and a
protected session later compacted natively (both stay blocked, with one notice
pointing to a new session), and a first-use journey: one notice on opening, a
read-only self-check, a declined one-turn `/compact` with no notice or marker, a
harmless `/compaction-recover` on a healthy session, the first checkpoint, history
retrieval and reopening.

Before the fix, the same new checks failed on the v0.3.2 package: `/compaction-recover`
on a healthy session left a `CONTEXT_PREVIEW_COMMIT_UNCONFIRMED` marker, an
unreadable configuration left `CONTEXT_CONFIG` markers that survived the fix, and
blocked inputs showed two to four identical notices. Re-running the unchanged v0.3.2
package through the isolated acceptance runner passed all 26 legacy checks; only
the new self-check case failed, as expected.

A probe package placed inside this repository and loaded by official Pi 1.0.4 read
`VERSION` 1.1.0 from the patched workspace build; outside any Node project it read
1.0.4. Acceptance therefore now runs from a temporary copy and stops if a Pi
installation could shadow the host under test.

Long-session overhead is unchanged and remains a known gap: 358 ms per request at
10 checkpoints (3.0 MB) and 1,153 ms at 20 (5.9 MB), against 370 ms and 1,104 ms
for v0.3.2 in the same environment and about 4 ms without the extension. Profiling
five requests on the 10-checkpoint session attributes about 80% of the time to
`hashEntries` (JSON serialization): re-validating every stored checkpoint's source
prefix accounts for most of it and the failure store's disk readback for the rest,
and each runs in three request hooks. The new classification adds about 1 ms. Caching
serializations or skipping readbacks would weaken tamper detection, and one-pass
prefix hashing needs a change to shared note code that both the resident fingerprint
and the frozen evaluation cover, so no optimization is included.

A walkthrough drove the official Pi 1.1.0 CLI as a new user would: `pi install`
from a loopback Git server, RPC sessions for `/compaction-doctor`, a declined
short `/compact`, a first checkpoint after about 31,000 estimated tokens,
`context_history` retrieval, a misquoting writer with one notice per blocked input
across a restart, recovery through `/compact`, an older natively compacted session
left to Pi, and `pi remove` by repository with session files unchanged.

## v0.3.2 retry compatibility, 2026-10-11

The independent retry runtime `stock-preview+src.105cef2556da81ad` preserves
original JSONL evidence while accepting Pi's omission of the latest failed
assistant response. Validation used official npm Pi 1.1.0, with Pi 1.0.4 only
for the unsupported-version control, and synthetic loopback services.

| Command | Result |
| --- | --- |
| `node scripts/context-memory-ops.mjs verify` | Exit 0: offline build, static/dependency/type checks, 147 focused regressions (94 resident and 53 preview), and 461 host security checks passed. The resident fingerprint did not change. |
| `node scripts/context-memory-preview-build.mjs` and `node scripts/context-memory-preview-acceptance.mjs` with an isolated official Pi installation | Exit 0: the independent artifact passed all 26 package and lifecycle checks, including source tampering, invalid citations, failed writes, cancellation and explicit recovery. |
| `node scripts/context-memory-preview-scenarios.mjs` with both official installations | Exit 0: 83 checks passed, 17 existing known gaps, zero failures, zero unexpectedly passing gaps and zero skips. All 20 long-session checkpoints committed. |

Retry scenarios now require success for transient 503s, connection drops,
partial-response drops, repeated failures and the first request in a session.
Retry exhaustion leaves no compaction marker and a later healthy request works.
After successful retries, manual compaction, original-history retrieval,
reload and reopening are required checks. Removed partial responses stay out
of the assistant messages sent to both the provider and the memory writer.

A legacy unsupported-edit marker remains blocking until explicit `/compact`
confirms a new checkpoint on disk. `/compaction-recover` cannot clear an
unstaged marker. Text-only overflow recovery keeps the whole unfinished user
request. Replacement content, user/successful-response edits, sibling or
forward references, edits crossing an existing checkpoint and tool-call
omissions remain rejected; valid edits do not clear pending or failed
compaction attempts. Six former retry/overflow known gaps are required checks.

Automatic compaction, unsupported input/session formats, notice behavior and
long-session overhead remain outside this fix. These results establish
scripted lifecycle behavior, not real-provider reliability or semantic quality.
The older validation records below describe their original release candidates.

## Default-settings scenarios, 2026-10-11 UTC

`scripts/context-memory-preview-scenarios.mjs` ran the v0.3.1 candidate
`stock-preview+src.6c2f3745fb7c2fbe` on official npm Pi 1.1.0, and on 1.0.4 for
the version case, with default Pi and extension settings. Each case ran beside a
control without the extension. The loopback provider returned ordinary replies,
one transient 503, one dropped connection, one context-overflow error or
threshold-level usage. 22 checks passed and 23 are recorded as known gaps;
every control run behaved as stock Pi.

| Scenario | Current preview | Control without the extension |
| --- | --- | --- |
| Documented first compaction | With default settings, `/compact` after one turn is rejected by Pi's 20,000-token keep-recent gate before any extension hook. With about 31k estimated tokens of later history it writes an extension checkpoint. | Not applicable |
| Transient 503 or dropped connection | Pi's default retry appends a `context_edit`. The preview treats it as unsupported, blocks the retry and writes a marker; `/compact` and `/reload` do not recover. | The retry completes |
| Context-overflow error | Blocked in the same way, with no recovery through `/compact`. No native summary is requested. | Native compaction recovers |
| Threshold-level usage, 115,000 of 128,000 | Native compaction is cancelled and requests are blocked; manual `/compact` recovers. Each blocked input shows four identical `CONTEXT_PREVIEW_UNSUPPORTED` notices. | Native compaction runs |
| One image attachment | The request is not sent and the session stays blocked, including after `/compact` and `/reload`. | The image request is sent |
| Session with a native checkpoint | Opening it writes a `CONTEXT_MIGRATION_REQUIRED` marker before any input. | Usable |
| Session created with the extension, then compacted natively | Blocked when the extension returns. | Not applicable |
| In-memory session | Every request is blocked. | Usable |
| Pi 1.0.4, fresh session | Every request is blocked and a marker is written. | Usable |
| Misquoting writer | Rejected and blocked; an explicit retry recovers. The failure shows two notices, and each blocked input two more. | Not applicable |
| Long session | Extension overhead per model request is about 310 ms at 10 checkpoints (3.0 MB) and 960 ms at 20 (5.9 MB). | About 3 ms on the same file |

A separate manual run reached 60 checkpoints (17.9 MB) at about 7.1 seconds of
overhead per model request. In an earlier attempt, the loopback server closed an
idle connection at checkpoint 36; Pi retried the connection error and the session
was blocked as in the dropped-connection case.

The runner loads a copy of the package from outside the repository. Inside it,
after `npm run build:offline`, the package's `@earendil-works/pi-coding-agent`
import resolves to the repository's workspace build rather than the host under
test; on Pi 1.0.4 the preview then read version 1.1.0 and did not block. The
`verify` workflow runs the acceptance runner after that build with the package
under `.artifacts/`, so its CI acceptance links the preview against the
workspace build. The publication workflow does not run that build before
acceptance.

The automatic-compaction case of the v0.3.1 acceptance reports 200,000 input
tokens in a 128,000-token window. Stock Pi handles that on its silent-overflow
branch, not the threshold branch; the threshold scenario covers the threshold
branch itself.

These are deterministic loopback results. They do not measure real-provider
behavior or recovery quality.

## Independent stock-Pi candidate, 2026-10-11 UTC

The v0.3.1 preview candidate `stock-preview+src.6c2f3745fb7c2fbe` was bundled as an
extension-only package and tested on an isolated official npm Pi 1.1.0
installation. The package graph contains eleven preview/shared primitive source
files and external public Pi/TypeBox imports; it contains no resident lifecycle
or host source. The existing resident runtime fingerprint and six host files
were unchanged. Publication uses the same runtime fingerprint with release metadata; the Git branch and package tag are separate from the source tag.

| Check | Result and scope |
| --- | --- |
| Focused context checks | 131 passed: the existing 94 resident cases and 37 independent-preview cases. Static, dependency, import-graph, install-lock and TypeScript checks also passed. |
| Host security and compatibility | 461 passed, in groups of 107, 240, 3 and 111; synthetic inputs and mocked providers. |
| Frozen resident evaluation | 89 passed with network denied and zero model budget: the existing 81 cases plus eight Git-backed checks that preview-only files are separate while host/shared code and fixtures remain frozen. The runtime pin did not move. |
| Official Pi acceptance | All 26 checks passed using the actual built artifact, a loopback Git server and a loopback HTTP provider. No real provider credentials or remote model service were used. |
| Distribution lifecycle | Official CLI downloaded the standalone package, updated that package, selected a compatible prior tag, and removed it. Existing dummy extension declarations and third-party settings survived. Rollback used the same checkpoint schema and code with synthetic distribution metadata, not a historical released preview. |
| Compaction and continuation | A valid checkpoint was saved and confirmed through JSONL readback; current-branch original evidence was retrieved through `context_history`, including after reopening in a fresh process. |
| Failures and recovery | Wrong quotations, fabricated/unreadable citations, malformed notes, unavailable writers, changed sources, cancelled generation, failed checkpoint append and marker IO stopped the workflow. Blocked prompts and reload/reopen attempts sent no additional HTTP requests. Explicit retry retained unfinished user input; explicit recovery confirmed an already staged/saved checkpoint without a model call. |
| Other request paths | A real stock threshold event was cancelled with zero writer/native-summary calls. Stock cache warming was stopped through the public decision event after compaction failure, without changing the cache-warming setting. |
| Official host identity | npm package integrity was recorded. SHA256 values for the manifest, CLI bundle, public index, SDK, extension runner and session manager matched before and after acceptance. |

Independent review found and reproduced two recovery defects: a blocked prompt
left an aborted tail that made manual retry impossible, and a directory-sync
failure after marker deletion lost staged recovery evidence. The former was
fixed by retaining the whole unfinished input turn during explicit retry; the
latter by preserving the staged attempt/hash during failed confirmation.
Both corrections were tested again in the final candidate. An interrupted
commit-observation scenario used the actual marker captured at Pi's append
boundary, then reopened in a fresh process for explicit recovery.

Scope remains the [candidate contract](extension-preview.md): official Pi 1.1.0,
one writer process, persistent text sessions, manual completed-turn compaction
and the declared explicit-recovery exceptions. Background warming is paused;
automatic scheduling, attachments, parent-history grants, old checkpoint
migration, other context-transforming compactors and Windows are not supported
by this candidate. JSONL readback is bounded to 64 MiB/250,000 records. A first
marker that cannot write any bytes only establishes a current-process block;
cross-process persistence after that storage fault is repaired is not claimed.
Real-provider behavior, semantic recovery quality and long-session request
overhead were not measured. Existing live results below remain resident-build
evidence and are not relabeled as preview results.

The reproducible checks are the package builder and independent acceptance
runner documented in the candidate guide. Temporary Git servers, package
checkouts, caches, synthetic credentials/configuration and session files were
removed after acceptance; compact result/provenance metadata was retained.

## v0.3.0: Pi v1.1.0 port, 2026-10-09 UTC

v0.3.0 moves the host baseline to upstream Pi v1.1.0, commit `abe508e1b89912adde45528136c3221eb69acdd7`. The project delta was replayed onto that source; conflicts in the six compaction host files were resolved against the v0.99.2 port recorded below. Upstream did not change `session-manager.ts` or `agent-session-runtime.ts` between v0.99.2 and v1.1.0; those two files match the v0.99.2 candidate apart from formatting, and the other four carry the same integration changes on the newer upstream code.

| Check | Result and scope |
| --- | --- |
| Context-memory regressions | 94 passed, including the three persistence cases updated for first-user publication and the six stop-send protections that depend on resident errors propagating from the ordinary `context` phase. |
| Host security and compatibility | 453 passed in four groups of 99, 240, 3 and 111. The six `packages/agent` harness checks were removed with the upstream code they covered; three new checks cover the durable JSON merge repair. |
| Static, dependency and type checks | Biome, pinned and runtime dependency checks, relative-import and entry-graph checks, the coding-agent install-lock check and TypeScript 7 `tsc --noEmit` passed after a clean `npm ci`. |
| Offline build | `npm run build:offline` passed with the pinned v1.1.0 model data. |
| Upstream compaction-related regressions | 86 passed and two skipped across `compaction`, `compaction-serialization`, `settings-manager-compaction` and the fork compaction-label regression. The skipped cases require real Anthropic credentials. |
| Offline evaluation | 81 evaluator tests passed with network access blocked and a zero model-call budget, against the re-pinned runtime. |
| Compiled resident startup | With an isolated home directory, a synthetic model and ordinary extensions disabled, RPC state and command queries succeeded, `/compaction-status` was registered and no extension error or model request occurred. |

Upstream's complete coding-agent suite is not a gate for this distribution, and it was run only to look for unexpected failure classes. Under an isolated home directory, 2,381 of 2,887 cases passed. The current v0.2.4-based source, run the same way, passed 2,130 of 2,478. Both runs fail for the same structural reasons: tests that construct `AgentSession` outside `createAgentSession` stop with `CONTEXT_RESIDENT_REQUIRED`, tool lists include the resident's tools, and concurrent fixtures meet session leases. One additional class appears on v1.1.0: virtual models without a declared context window are rejected with `CONTEXT_CAPACITY`, matching the existing handling of unknown windows. Tests for the new built-in MCP and codemode extensions construct sessions directly, so they do not show whether those extensions work alongside the resident.

No real provider, cache behavior, Windows persistence, real historical-session migration or third-party extension was exercised. The experimental session-worker and mini paths still use the separate JSONL harness, whose keep-none compatibility remains outside this check.

## Pi v0.99.2 isolated host-port check, 2026-10-01 UTC

A disposable resident-host port of compact source `484d85a185a3e91762d4185bf13743bf11babb48` was checked against upstream Pi v0.99.2, commit `005af57d88ee23b33778f343a9595b32e67ff788`. The port replayed the six host integrations onto the newer source while retaining its finalized-context refresh and immediate persistence of the first user message. This check establishes feasibility for that adapted host; the port is not included in this repository or released assets, and the published baseline remains Pi v0.86.0. It does not establish installation as an ordinary extension on unmodified Pi.

| Check | Result and scope |
| --- | --- |
| Original Pi v0.86.0 core regressions | 94 passed before the port. |
| Adapted Pi v0.99.2 compact core regressions | 94 passed. Three persistence fixtures were adjusted for immediate first-user publication; write rollback, source-file protection and failed-fork assertions were retained. |
| Upstream v0.99.2 compaction-related regressions | 86 passed, two skipped. The skipped cases require real Anthropic credentials. |
| Type checking and build | Complete TypeScript checking and offline workspace build passed; the coding-agent bundle was rebuilt after the final host adjustment. |
| Compiled resident startup | RPC state and command queries passed with an isolated configuration and in-memory session. The resident compaction command loaded even with ordinary extensions disabled; no model prompt was sent. |

The context-phase split requires an explicit port adjustment. Pi v0.99.2 runs ordinary `context` transforms separately from `context_with_system`. A mechanically merged candidate initially passed 88 core cases and failed six stop-send protections because resident exceptions were no longer propagated from the ordinary `context` phase. Restoring fatal resident error propagation in that phase made all 94 core cases pass, including failed automatic compaction, missing or stale recovery content, and opaque-history refusal. This is a host-port requirement, not a fix shipped by this documentation change.

The preserved source delta was replayed onto the pinned upstream tree and matched the tested candidate tree. No real-provider quality, cache behavior, Windows persistence, real historical-session migration or third-party integration was measured. Experimental session-worker and mini paths use the separate JSONL harness; their keep-none compatibility remains outside this check. These results do not expand the released compatibility range or change the planned stock-Pi extension's implementation status.

## Readable supersedes references

The note validator now applies the same branch-membership and readable-content check to `supersedes` and `sources`. Readable older originals remain valid even when the current fact cites only the newer ruling in `sources`. Checkpoints, metadata, empty text, future and sibling entries are rejected before commit; persisted invalid supersedes are also refused on reopen, with original history retained.

Two focused runtime regressions bring context-memory checks to 94; 456 host security/compatibility checks pass. The evaluation's four structural counterexamples and report expectations are explicitly updated to three hard failures and one accepted original-reference case, including commit refusal and persisted-note reopening. The evaluated runtime advances through `eval/runtime.ts`; fixture/scorer bytes and original preparation results stay frozen, and historical live results keep their original runtime identity. No new provider calls or installation changes accompany this fix.

## 0.3 measurement: bounded live validation, 2026-09-22 UTC

The evaluation implementation supplies versioned fixtures, deterministic probes/scoring, isolated checkpoint and task runners, and an explicitly authorized subscription transport. The compaction runtime stayed pinned to `149e253cebc56b8e732022e79c294fce5ebb5cbc`; fixture/scorer content stayed frozen. These additions establish a reproducible method, not a completed provider-quality baseline.

All real calls used `openai-codex/gpt-5.6-luna` with thinking `max`. Early attempts and partial results remain part of the record:

| Stage | Observed result and limitation |
| --- | --- |
| Initial request and two diagnostics | Three attempts: two returned no HTTP Response and did not retain enough transport evidence to establish the cause; the third returned HTTP 400 explicitly rejecting `max_output_tokens`. Missing usage was retained as unknown. |
| Project replay with local output limits | One request ended at about 180 seconds. Successful-response pre-reading in the diagnostic observer was subsequently removed. Observer interference and an insufficient time limit remain candidate causes; this sample is not a reliable performance comparison. |
| Native partial execution after the observer fix | First compaction completed in 73.988 seconds; time to the recovery request was about 74.000 seconds. Of eight first-checkpoint recovery probes, three passed, four completed without passing (three response-format failures and one authority mismatch), and one was blocked by its tool-round limit. The second writer exceeded 180 seconds without a terminal event; it emitted both reasoning and text. |
| Minimal project long-chain attempt | F2's first two boundaries and one existing continuation probe per boundary were selected, capped at eight requests and ten minutes. Only here, the writer timeout was 600 seconds; task, action and output limits stayed in force. The first request completed in 236.664 seconds with 60,365 input tokens and 12,894 output tokens, including 10,592 reasoning tokens. It exceeded the local 10,000 total output limit and was rejected before parsing/commit. No checkpoint committed; the second compaction and both recovery checks were blocked. One request was used, with no retry or judge. |
| Final calibrated project attempt | Writer output allowance raised to 32,768 including reasoning, with note commit allowance and 8,192 probe output unchanged. The ten-minute window was reset once; seven of the original eight requests remained. First compaction committed in 216.675 seconds (3,807 estimated note-JSON tokens within a 5,000 limit); its continuation set staging.port to 4317, preserved audit.complete=true and left production.ledger unchanged. Second writer completed in 328.173 seconds, but the note's state[0] quotation existed in f2-00181 while citing other entries. CONTEXT_NOTE_QUOTE rejected commit; the second continuation was blocked. Four requests, 555.505 seconds, no retry or repair; the two minimal attempts used five requests in total. |


The first minimal attempt establishes that its request can complete beyond 180 seconds, but does not establish note validity, note-size compliance or successful recovery. Its output limit counts reasoning; the 2,302-token non-reasoning difference is not a substitute for checking the serialized note. Failed probes and unstarted work are not removed from the record to improve the apparent result. Settings differed between stages, so these observations cannot be treated as a controlled project/native comparison.

Across these stages there were 34 client request attempts. Twenty-nine responses supplied actual usage: 586,132 known input tokens and 57,460 known output tokens. Five attempts remain unknown, with their conservative input/output reservations retained. Explicit estimation is permitted for successful responses lacking usage, but no successful response in this record required it. Reported actual totals therefore remain partial; subscription cost is not inferred from API catalog pricing.

The latest broad offline checks had passed 81 evaluator tests, 92 context-memory regressions and 456 host security/compatibility regressions. The initial minimal selection and its final allowance calibration were each checked by the same single targeted offline test and a TypeScript check, without rerunning the full matrix. The final check also verifies that only writer output changes to 32,768 while the note commit allowance and probe ceiling stay unchanged. That test verifies two checkpoints, the state/action/permission continuation checks and the request bound using scripted responses; it removes its own scratch directory and does not establish model quality.

Under the reduced budget, the remaining 16 original runs were closed as unstarted. The two-arm baseline is deferred. The minimal real validation has been executed with one passing checkpoint and continuation, but continuous two-checkpoint recovery has not passed. The final failure is a source-to-quotation mismatch after a complete response within the revised output/time limits; the commit guard preserved the earlier checkpoint and refused the bad candidate. No further real attempt is authorized in this sequence. A future change would need separate evidence for quotation attribution and pause costs before claiming a broader result. These evaluator changes do not alter the runtime version, release tags or published release assets.

## v0.2.4: Pi v0.86.0 compatibility, 2026-09-20 UTC

The v0.2.4 build preserves v0.2.3 compaction behavior on upstream `ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc`. A clean dependency installation, complete offline build, static/type/dependency/entry/generated-lock checks, 92 context regressions and 456 host security/compatibility regressions pass. The security groups contain 97, 235, 13 and 111 checks.

The security suite additionally covers long malformed Cerebras status messages and hostile persisted tool-slot indices; these checks are synthetic and do not execute provider calls.

The two additional context regressions verify transcript prompt/tool-state replay through keep-none compaction and reopening, including removal of a tool and absence of a duplicate writer header, and handler snapshot/unsubscribe semantics with the resident running last. The existing natural tool-loop test now expects the upstream system-state message alongside the checkpoint. Existing persistence and history-grant cases remain passing.

This patch release changes the Pi baseline without introducing a new compaction strategy. Published v0.2.3 assets are unchanged. No real provider invocation, original-session migration or third-party plugin change was performed. Custom providers must implement Pi v0.86.0 transcript inputs; historical third-party integration results below do not establish compatibility with this release. The separate agent JSONL harness remains outside coding-agent's session path; its keep-none import compatibility is not claimed.

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

### v0.2.3 budget and recovery checks, 2026-09-13 UTC

The complete offline build and focused static/type/dependency/entry checks pass with 90 context-memory regressions (54 existing and 36 new), plus the existing 429 security/compatibility checks. No dependency or host source file changes are required; full and production npm audits report zero vulnerabilities. The new cases cover tier boundaries, explicit fixed limits, small-window caps, previous-note floors, released versus retained sources, image/reasoning payload exclusion, elastic acceptance, both writer paths, one repair across multiple chunks, per-call usage, repair-disabled/failure/cancellation/source-change paths, reference/quotation loss, bounded repair requests, stored-budget tampering, model changes, new-process reopening/fork/retrieval above 6,000, legacy checkpoints, reviewed-copy migration and report compatibility.

An isolated compiled SDK check used `openai-codex/gpt-6-astra` at high effort. Source turns were **seeded synthetic fixtures with repetitive background text**, not autonomous task/tool execution. Two manual checkpoints measured 50,105 and 250,115 released-source estimated tokens and selected tier 1 (3,000/4,000) and tier 3 (5,000/6,000). Both first writer responses committed without repair; their JSON sizes were 1,853 and 1,972 bytes, and compaction pauses were 19.113 and 21.871 seconds. These low-density fixtures verify budget selection, not that these budgets suffice for every task of the same length.

After disposing and reopening the persisted session in the same process, a real model used history retrieval and correctly distinguished initial/current ports and timeouts, the original rejected port and error, the verbatim no-write/no-deploy restriction, the two original source IDs and the pending reporting action. New-process opening is separately covered by the offline worker test. A separate size-repair check injected a valid oversized **synthetic initial candidate**, then made one real same-writer repair call. It reduced 6,038 JSON bytes to 810 within a 3,000-byte hard limit, preserving the checked values, source IDs, restriction and next step. The repair took 15.209 seconds and its request was about 13k bytes; it did not replay the large conversation. This is not a naturally occurring overflow or an autonomous continuation test.

The final live run took 68.047 seconds, with three real writer calls and two main-model responses. Writer-reported usage totaled 160,801 tokens and catalog-estimated cost about $1.67, excluding main-model calls; this is not an invoice or a savings comparison. Existing global configuration and sessions were not changed by the test. Runtime build: `0.85.1-context-memory.0.2.3+src.c783c4b391c12537`.

An earlier run passed its numeric recovery assertions, but inspection found the old internal “stop the task” handover instruction copied into the notes as a new user restriction. The writer prompt now explicitly distinguishes its internal JSON-writing control from task authority. The final rerun added checks for this specific contamination and for the fixture's remaining reporting step. Both runs are retained privately; the first is not counted as a semantic-quality success. Prompt wording is not a proof against arbitrary future contamination. Neither run measures a daily failure rate, near-1M behavior, complex high-density decisions, other providers or recovery accuracy against native Pi.

### v0.2.2 release verification, 2026-09-12 UTC

The candidate passes a clean `npm ci --ignore-scripts`, pinned model-data extraction, the complete offline build, 54 context-memory regressions and all 429 security/compatibility regressions under Vitest 4.1.11. Static, type, dependency and entry-graph checks pass. Both full and production-only npm audits report zero vulnerabilities. The production shrinkwrap and installer locks remain byte-identical to v0.2.1 and pass their generation checks; the workspace lock changes only the Vitest package family and its workspace declarations.

Dependabot PR #16 proposed the relevant Vitest security update but failed during `npm ci` and did not update the root workspace lock or matching coverage peers. The release applies the same 4.1.11 security target with the two coverage declarations aligned, without adopting the bot's rewritten production shrinkwrap. The advisory concerns a development server; this release does not claim that the normal Pi runtime exposed that server.

The Astra run below preceded release stamping and the development dependency update. Its runtime source matches the release candidate except for the generated build identity; no additional live model run was needed for the test-tool update. The build is `0.85.1-context-memory.0.2.2+src.32fa13eec5d1fb6d`, with the same Pi v0.85.1 host baseline. Global installations and existing sessions are not changed by publishing this source release.

### Astra 10k live check, 2026-09-12 UTC

An isolated compiled Pi AgentSession used `openai-codex/gpt-6-astra` at medium effort for task work and the session writer, with `compactAt: 10000`. This was a trigger setting, not a reduction of the catalog model window (1,050,000). The 1,500-token note allowance remained unchanged. All assistant/tool turns were generated by the real model; compaction was automatic, with no seeded transcript turns, manual checkpoints or substituted writer responses.

The first run committed one checkpoint, then stopped on `CONTEXT_NOTE_BUDGET` at the second writer response. The next inference was blocked, with no additional writer retry. Paid usage was retained. One history call also failed because the model omitted the original entry ID when following a cursor. The failed writer's raw text was not captured in that run, so its exact byte size cannot be reconstructed from provider token usage.

Both writers now receive the actual JSON UTF-8 byte limit and a target at 75% of the limit, with guidance to deduplicate facts and retain retrieval anchors for bulky recoverable detail. The hard validator still refuses excess without truncation or retries. History parameter descriptions, prompt guidance and errors now explicitly require the original query parameters alongside the cursor. Two additional synthetic budget regressions bring the context-memory suite to 54; static/type/dependency/entry checks and all 429 security/compatibility regressions pass. The updated SDK build passes.

Repeating the same task on the corrected build passed with 42 main-model calls, nine writer calls and nine automatic in-task checkpoints. The first user turn audited eight synthetic ledgers (288 records); a second user ruling changed the approved configuration and audited four more (144 records). Both outputs matched every record/rejection count and all per-file first/last SHA-256 traces. The initial failed configuration remained distinct from a superseded approved configuration, the original write restriction was recovered verbatim, and unapproved proposals in source records did not change the outputs. All source files and the first output retained their original hashes. Each checkpoint was followed by further tool work in the same stage.

After disposing the session and reopening its JSONL in the same Node process, a history-only probe recovered initial/current values, the original failure reason, the exact restriction and both original user-entry IDs. This is session reopening, not a fresh-process cold-start test. There were 12 filesystem reads, 25 history calls and two writes, with no tool errors or attempted out-of-scope writes. The isolated configuration did not change the normal installation or global configuration.

The passing run took 643.660 seconds. Compaction pauses totaled 371.428 seconds (57.7% of elapsed time), with a 40.130-second median and 37.001–46.853-second range. Trigger-time estimates were 10,586–13,594 because the host checks after complete tool batches; recovered context was about 1.82k–2.28k by the extension estimator. Raw note JSON used 1,249–1,445 estimated tokens. Provider-reported cumulative usage was 385,281 tokens, including 150,159 for writers; repeated input and cached input are included, so this is neither window occupancy nor comparative savings. The passing run's writer text and source hashes were retained privately for diagnosis.

This is one passing stress sequence after one real failure, not an estimated failure rate or proof of lossless memory. It did not reproduce premature completion or replies to an old task, and it did not run a live ablation of the recovery guards. Prompted budget compliance remains probabilistic. The result supports further maintenance of the recovery mechanism while exposing substantial pause and retrieval costs at 10k; it does not establish that 10k is an appropriate everyday default. Native Pi comparison, multi-day tasks, near-window behavior and other providers remain unmeasured.

### Recovery hardening, 2026-09-11

At this stage the context-memory suite contained 52 synthetic regressions. Before the fixes, five targeted assertions failed: missing recovery notes still allowed a model request, stale notes did the same, a final payload without the checkpoint was accepted, repeated automatic handovers lost the exact current request, and a schema-valid note with no next step allowed an unfinished task to continue into a generic final reply.

The added checks cover missing and stale context summaries, the serialized request boundary, an empty continuation step, damaged original sources and summaries on reopen, chronological original requests plus steering, image retention, and oversized-request refusal before a writer call. The two-checkpoint tool-loop test now deliberately omits an exact user constraint from the writer's note and verifies that the controller preserves the original independently. New checkpoint continuation text is checked before publication, restored after reopening, and remains before subsequent user corrections. No real model is used: the final reply and tool calls are scripted, so passing does not establish model adherence or semantic recovery quality.

The focused static/type/dependency checks and all 429 existing host security and compatibility regressions pass. These changes were first validated on an unreleased v0.2.1-based working tree and are included in v0.2.2. The new synthetic checks need no provider credentials. At this stage, real-provider payload compatibility was unmeasured; the subsequent Astra sample is recorded above. Multi-day recovery quality, full-window latency and comparison against native Pi compaction remain unmeasured.

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

The checks use synthetic input and mocked providers; OAuth callback checks use a local loopback server. They do not make model requests. The 90 context-memory regressions remain a separate check. Passing these checks does not establish that every scanner alert is exploitable or resolved; remote CodeQL and dependency results must be checked on the pushed commit.

## Practical limits

This is one task-level recovery result, not proof of lossless memory. Repeated increment-versus-boundary A/B comparisons were not run. Long-running quality, maximum-window behavior, Windows persistence, terminal/RPC interaction and all third-party extensions have not been comprehensively tested. The full upstream suite and browser smoke checks are outside this validation record.

Use synthetic reproductions when reporting failures. Do not attach a complete real session to demonstrate a missing fact.
