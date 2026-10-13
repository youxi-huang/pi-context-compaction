# Claude Code cloud handoff: simplify the plugin and close a minimal B loop

## Mandate and delivery boundary

The maintainer ends this session at an **unmerged PR**, not a release. Do not
merge, create tags, advance `extension-preview`, or publish assets without a later
instruction. The prepared version is `v0.4.0-preview.1`, an experimental A stage;
the full v0.4.0 still requires the A/B comparison and its performance acceptance.

The maintainer explicitly authorizes the next worker to reassess, replace or
delete this session's design. The large authority proposal and its prototypes
are **not mandatory building blocks for B**. Optimize for a small, natural Pi
plugin, using official public extension APIs and native session records. Review
this handoff against actual code before following it.

Keep source/reference validation, branch isolation, fresh disk-confirmed formal
commits, formal-compaction failure blocking and reliable records of incurred
calls/costs. Simplification may change mechanisms; it may not remove those
properties or make a failing test disappear to claim completion. Do not introduce
routine input reviews, repeated confirmations, or a mandatory strict-mode switch.

## Obtain the exact code

The PR head branch is `codex/v0.4.0-preview1-handoff` in
`youxi-huang/pi-context-compaction`, based on
`e83a7bf8631c1d2d2e93a8d6e9676b1b39bc970c`. The implementation is committed as
C1 (`2ccd555a26f42cae66c9eb76207e4caf63aa9d64`); a separate C2 maintains
`eval/runtime.ts` at that actual C1 SHA. The PR's head
SHA is the authoritative complete handoff revision; read it from the PR, then
pin the checkout to that value. No uncommitted source is required to reproduce
the delivered tree.

```sh
git clone https://github.com/youxi-huang/pi-context-compaction.git
cd pi-context-compaction
git fetch origin codex/v0.4.0-preview1-handoff
git switch --create claude/v04-simplify FETCH_HEAD
git rev-parse HEAD
git status --short
cat eval/runtime.ts
git log --oneline -3
```

This creates a local work branch at the exact fetched PR head. Compare the
printed SHA with the PR head before
editing. Do not use the main branch or a published package tag as a substitute.
Do not squash away C1 while keeping a pin to an unavailable commit. A fallback
patch and Git bundle are prepared locally for transfer; the PR branch is the
cloud-accessible primary path. A patch alone does not preserve pinned history:
fetch C1 or import the bundle before running the frozen evaluator.

Read `AGENTS.md`, `CONTRIBUTING.md` and
[operations](operations.md) first. This project uses the official Pi 1.1.0
baseline, not the upstream release process. Root `package.json` is workspace
metadata, not the extension version. Never use this repository's patched host
as proof of independent stock-Pi compatibility.

## Current facts and limits

| Area | Actual state |
| --- | --- |
| A | Optional settled-turn preparation by the configured writer; disabled by default. In-memory immutable cumulative candidates, complete-current reuse, same-writer tail merge and synchronous fallback are connected |
| Formal commit | One existing pending → stage → native checkpoint append → exact fresh disk confirmation path. Formal failure blocks later requests; optional preparation failure does not enter it |
| Accounting | With A preparation enabled, durable bounded preparation and separate foreground observations, actual dispatch reservations, partial/unknown usage, discarded work and restart/orphan handling. With preparation disabled, failed foreground calls still rely mainly on in-memory `lastProgress`; do not claim universal durable call accounting |
| Shared validation | Ordered single-pass prefix SHA hashes preserve existing bytes. Preview can borrow exact canonical branch lines only inside one synchronous owned validation invocation; it does not cache success across hooks/requests |
| B today | `context_note` already records model-generated suggestions in native custom entries and feeds them as unverified writer hints. No complete per-turn B strategy or accepted A/B comparison exists |
| Authority prototypes | Ownership bridge, refusal guards and bootstrap/SDK drivers are unused by the production extension. Their ownership seal does not authorize instruction projection |
| Historical-prefix submission | Design only; the active commit still covers the full submitted branch. No earlier-cut/retained-tail strategy is enabled |
| Preview release | Prepared version/tooling only. No source/package tag, release asset or package-branch update is authorized in this session |

Pre-handoff functional evidence passed: 520 focused runtime checks, 57 script
checks, 461 synthetic host-security checks and 27 official-Pi package checks.
The PR description records the final clean-source commands, counts and exit
codes after release-profile tests and C1/C2 maintenance. This paragraph describes
the earlier candidate and does not replace that final evidence.

Production preview source is `stock-preview+src.a8fcd0a35240f1fd`, source SHA-256
`a8fcd0a35240f1fdcf505e1cbbf6e3d7ca68120ffe4cd8143c8c243c26604d76`;
bundle SHA-256 is
`2c7259319766dddc4eb8a2f3964cc245e28242c1ec814e21954811054db389b1`.
Package metadata/archive identities change with a clean commit or README even
when those runtime bytes do not. Use each report's exact manifest and artifact
hashes; never relabel an old report as a newly built archive check.

Two recorded S1 runs fail both the 50 ms goal and required growth bound:

| Run | Extra overhead, 10 CP | Extra overhead, 20 CP | Growth |
| --- | ---: | ---: | --- |
| Standalone hardened candidate | 57 ms | 122 ms | Fail: 122 > 2 × 57 |
| Complete scenario suite | 54 ms | 121 ms | Fail: 121 > 2 × 54 |

The final clean C2 full CI command exits 0: 137 script, 520 runtime, 461 security,
27 official-package and 89 frozen scripted evaluator checks pass. Its scenario
summary is 126 pass, one 50 ms known gap, zero failures/unexpected passes/skips.
C2 is `1f7576e41639c616c683454e1687db859d6dd589`; extra overhead is 46/84 ms,
so this one run passes growth (`84 <= 92`) while failing the absolute target
(`84 > 50`). It uses the same a8fc runtime, with clean C2 package metadata. The
documentation-only follow-up preserves this as C2 evidence, not a new measurement
or exact-package validation of a later commit. Retain the conflicting earlier
runs rather than declaring stable performance acceptance.

The absolute 50 ms check remains a known gap. The maintainer accepts the growth
failure **only for this functional preview version**. The profile records raw
failures and the scope exception; it must not become a performance pass or a
general exemption for v0.4.0. S2's tiny synthetic controls prove candidate reuse
and accounting interfaces, not natural hit rates, provider cache behavior,
complete billing, semantic recovery or stable whole-task benefit. Preserve
[validation](validation.md), including earlier failed artifacts and runs.

## Complexity audit: default recommendations

These are proposals for the next worker, not changes silently applied in this
PR. Inspect migrations and prove each property before removing a mechanism.

| Addition | Recommendation | Reason / required replacement |
| --- | --- | --- |
| `previewPreparation.enabled` | Keep one explicit opt-in initially | A incurs speculative calls; default must not buy work unexpectedly |
| Minimum source size, interval and deadline settings | Keep bounds, make ordinary values internal policy | A normal plugin does not need a public knob for every implementation threshold; retain cancellation/deadline tests |
| Per-attempt, interval and session call/token/cost limits; detail cap | Merge into a small budget policy with safe internal bounds | Reliable reservations and finite spending remain necessary; do not erase already incurred usage when simplifying settings |
| `preparation-candidate.ts` identity/freeze/classification | Keep; simplify representation where tests permit | Candidates need real source, branch, checkpoint and writer identities. `parentCandidateId` has no production supplier and can be deferred; do not accept model-authored coverage claims |
| `preparation-coordinator.ts` | Reduce to one owner for one running job, candidate selection and cancellation | Its purpose is real concurrent A work; avoid a second scheduler for B tool submissions. Remove the unused `markReused()` bypass after checking tests; production reuse must follow real disk confirmation. Treat `waitForIdle()` as test support |
| `preparation-ledger.ts` and `preparation-ledger-io.ts` | Keep accounting properties; consider one journal/implementation | Preserve dispatch-once IDs, durable reservations, unknown usage, no refunds, crash/reload history and bounds. `progress()` is test-only today; production `afterDispatch` settles each actual call. Evaluate native append durability before changing storage |
| Separate foreground/preparation ledger instances | Consider one store with a phase field | Avoid duplicated persistence and parsing, while preserving phase attribution and explicit recovery reservations |
| `lastProgress`, `lastCompaction`, status readiness/reasons | Merge duplicated observational state | Status should explain readiness and incurred cost, not expose every coordinator transition in the normal flow |
| Canonical line borrowing and whole-object plain-data proof | Retain only with measured benefit and adversarial proof | The fast path closes reproduced serialization/prototype mutation holes; if proof cost outweighs benefit, remove the optimization and retain safe parsing |
| Shared `hashEntryPrefixes` / oldest-first checkpoint validator | Keep one implementation | Byte-equivalence regressions and full checkpoint checks avoid another validator and quadratic hashing |
| `context_note` native candidate records | Keep/reuse for B, narrow data schema as needed | A native tool/custom record is sufficient to carry suggestions; do not invent a second candidate transcript or authority seal |
| `authority-bridge.ts`, `authority-bridge-guards.ts` | Defer; remove from active work scope if no independent owner exists | They are unbundled development prototypes, not production B dependencies. Preserve the negative findings and any real supported rollback contract before deleting code/tests |
| Authority bootstrap/guard CLI and their synthetic settings | Archive/defer with the full authority milestone | Scripted UI, synthetic model selection, dummy recovery markers, `--reader`, transport caps and injected guard timing do not create a product feature |
| Ordinary-input review, classification receipts, strict enrollment, minimum rollback reader | Defer as a separate optional product | Routine prompts must remain natural. No reviewed input UI, receipt kernel or request projection is implemented; do not make this speculative flow a compulsory B prerequisite |
| Historical-prefix proposal/new attempt format | Defer | Useful possible zero-generation path, but it adds cut/coverage/recovery compatibility semantics unrelated to the first B hints loop |
| Prefix/request component profilers and S1/S2 runners | Keep bounded diagnostics; consolidate duplicate harness plumbing | Measurement evidence needs source/artifact identity, finite calls and raw timing; instrumentation is not production architecture |
| Preview-specific acceptance profile | Keep internal, exact-version bound | User-approved release scope, not a runtime setting or a justification for weakening full v0.4.0 checks |

The proposed ordinary configuration surface is the existing total `enabled`
switch, `writerModel` (default `session`), and one optional preparation switch.
Keep existing `keepRecentTokens`/`writerEffort` compatibility as advanced settings;
consider `noteTokens`/`noteRepair` advanced policy. `eventLog` has no preview
consumer, and `compactAt` influences budget rather than enabling automatic
compaction. Do not imply these resident/shared settings create preview features.
Current internal experimental limits are source floor 2,048 tokens, interval
5,000 ms, deadline 120,000 ms, eight calls/attempt, one attempt/interval,
eight/sixteen calls per interval/session, 1.2/2.4 million reserved tokens,
one/two million cost micros and 64 detail records. These are caps, not an
accepted natural-use tuning strategy.

Ledger policy hashes bind all eight ledger parameters. Merging files or hiding
public knobs requires a reader/migration preserving old incurred costs and
reservations, or an explicit observation gap that stops optional paid work.
Never reset quotas by deleting old files, refund unknown calls or silently reuse
old reservations with a new policy. If universal durable accounting is required
for B or future ordinary compaction, address the current disabled-A gap before
claiming that property.

Before deleting prototype tests, identify which properties they test. Remove
tests that only sustain an abandoned prototype with that prototype; retain or
move regressions for source tampering, role escalation, cross-branch replay,
fresh disk confirmation and formal failure blocking. Unknown authority states
must not be silently reinterpreted as legacy if any real session can contain
them. These prototypes were not enabled or published, but prove that fact before
using absence of a migration requirement as a deletion argument.

## Target structure

Prefer the existing five roles rather than introducing more services:

1. `extension.ts`: public Pi tools/events/commands and short natural notices.
2. `controller.ts`: candidate selection and the **one formal commit entrance**.
3. Shared `notes.ts` / `identity.ts`: source/reference validation and hashes.
4. `writer.ts`: the **one configured writer implementation**. A background and
   foreground work use this path; B candidates are optional input data.
5. Failure persistence plus bounded call accounting: distinct invariants may
   share small IO helpers, but may not conflate optional candidate failure with
   a failed formal compaction.

A candidate owner may remain if it handles actual asynchronous A work. A B tool
submission should not require an additional worker, mode controller, permission
database or replay service. Native Pi records remain the only source history.
For every proposed abstraction/configuration/durable record, explain which
existing mechanism cannot provide its required property and show the smallest
counterexample. Avoid abstractions justified only by a prospective future arm.

No system-prompt renderer is exported by the official Pi 1.1.0 public SDK.
Internal `buildSystemPrompt*` files are not public API. `refreshContext()` does
not persist an instruction protocol. Do not revive the abandoned workaround.

## Minimal B contract to evaluate first

**Proposed first B is a hints-to-writer loop, not direct model-authored commits.**
It may be implemented only after the bounded mechanical boundary below passes.
If that cannot be proved, retain the design and defer B rather than enabling it.
Reconcile this smaller boundary explicitly with the roadmap; a full strict
authority protocol can remain a separately numbered milestone. Do not claim the
small experiment satisfies that protocol's stronger promises.

| Question | Minimal behavior |
| --- | --- |
| Who generates? | The current session model optionally calls the existing `context_note` tool as part of ordinary work. Use a short tool guideline around material decisions/completed work; no extra background writer, mandatory review or compulsory note every turn |
| What is generated? | Bounded, source-linked candidate data. Reuse the native custom-entry carrier and existing validators. Consider a minimal evidence schema with no authority-bearing `instructions` field; do not introduce that schema without explaining why existing `MemoryNote` is unsafe for this role |
| Who stamps coverage? | Deterministic extension code binds the actual current session/branch, base checkpoint, concrete original IDs and ordered source hash. The model cannot claim it processed a user ruling, stamp authority or choose an earlier cut |
| When is it usable? | After actual tool result/native record persistence is proved on stock Pi, and only on its verified current source lineage. Accumulate bounded hints through completed turns; do not treat a tool call's own prospective record as already committed original evidence |
| What invalidates it? | Source mutation, incompatible branch/parent checkpoint, schema/size/reference error or session change rejects the candidate. New user input requires latest evidence reconciliation at formal compact; old hints never imply newer rulings were processed |
| How does it enter formal compact? | Existing manual `/compact` passes valid B hints plus original evidence to **the configured writer**, then uses the existing full pending/stage/append/disk gate. B v1 does not take A's no-writer complete-candidate shortcut |
| What if notes are absent/bad? | Ignore/reject optional hints with a bounded observation and use the synchronous same-writer path. Never choose another writer or clear a formal failure marker |
| How is cost recorded? | Candidate tool use itself is not a free model call. Count actual session-model rounds/tokens where observable; record shared task+note usage as unattributable rather than inventing a split. Track additional note rounds and final writer usage, partial/unknown usage and discarded hints |

Mechanical checks must establish all of the following, not merely a prompt
saying “unverified”:

- Candidate bytes never become system/developer instructions, tool definitions,
  permissions, grants, settings, enrollment receipts or authoritative user input.
  Check the final provider payload and every accepted serializer/renderer path.
- Candidates cannot mutate formal state, source hashes, identities, budgets or
  retry/recovery decisions. Candidate fields cannot self-certify these values.
- Source existence, branch membership and exact quotations are deterministic;
  a quote of a tool/assistant/quoted user passage does not grant permission.
  A model-written “allow”, “revoke”, “ignore”, `instructions` label or source-role
  label remains candidate data, including when hidden in state/files/next steps.
- Candidate data is either excluded from ordinary task projection or carried in
  a bounded, explicitly data-only supported representation. The current
  `withPendingNotes` renders `MemoryNote` headings, including “Instructions”, into
  custom context; assess and change that route before treating it as a proof of
  non-promotion. A disclaimer alone is not a mechanical boundary.
- The final checkpoint may include only the behavior the existing source and
  commit contract justifies. If a writer can still promote candidate claims into
  permission/rule slots without deterministic original provenance, disable that
  path or narrow B further. User-role alone cannot distinguish quoted data from
  a direct instruction. Do not promise semantic instruction classification or
  prompt-injection immunity from source-role checks or a new JSON schema.

Prove tool-call/result pairing and first native custom-entry flush using the
actual public SDK. Other extensions can modify context/system/payload between
hooks; host forced-prompt projection can overwrite system after both context
hooks. Check the actual final transport boundary. Arbitrary extension/local-code
rewrites and model obedience are not proved by these tests. Defer direct B
checkpoint submission, strict mixed-input authority, revocation replay, old-reader
ownership migration, tree/fork strict navigation, historical-prefix commits and
automatic scheduling unless independently specified and accepted.

## Performance work: one independent track

The current `context`, `context_with_system` and `before_provider_request` hooks
each invoke controller validation. Single-pass prefix hashing removes the old
checkpoint-prefix quadratic serialization, but full branch serialization,
prototype proof, quote/schema checks, full JSONL readback and marker reads remain
repeated. Old artifacts show real improvement, but neither current target passes.

Start with one declared profile on the **same** source/artifact, separating
serialization, SHA, quote/schema work, source proof, disk read/line scanning,
marker IO and final payload checks. Measure proof and invalidation costs; do not
report only a successful fast-path interval. Do not repeatedly rerun unchanged
S1 to obtain a favorable sample.

First optimize within an invocation using owned immutable data and one shared
validator. Then assess same-request reuse only if a publicly available request
identity plus complete original-byte identity can be proved. An equal context
object, leaf ID, entry count, file size or modification time is not such proof.
There is no approved cross-request cache. If a robust request ID is unavailable,
keep that limitation explicit and investigate a smaller final-hook consolidation
only after proving equivalent protection for every supported dispatch route.

A small first experiment is to encode canonical UTF-8 once and use those same
bytes for SHA and readback, preserving original hash bytes and observer timing.
Then consider caching only pure derived indexes/validated results after proving
full fresh memory content and exact fresh disk bytes plus marker state. To skip
serialization itself, a private detached snapshot must compare every relevant
value/type/key order/descriptor without freezing host-owned entries or leaking
aliases. Measure that new comparison cost; none of these proposals guarantees
50 ms or the growth target.

The third hook requires a fresh boundary check: an earlier retained provider
payload callback can mutate sources before later dispatch. “No handler between
the first two hooks” is a source-inspection hypothesis, not an accepted general
contract. Cross-hook reuse must cover changed prefixes with the same leaf,
same-length disk changes, sibling/root changes, stale marker replacement,
prototypes/getters/toJSON, reload/session/branch changes, abort/retry/warming and
later callbacks. A cache miss/failure must fall back to full validation, never to
unchecked dispatch. Do not weaken fresh formal-commit disk confirmation.

Report absolute overhead and growth independently using raw nine-probe samples,
the unchanged medians/rounding and the existing control. A passing growth ratio
does not satisfy 50 ms; a lower absolute sample does not pass growth. Preserve
every failed report and exact identity. Existing synthetic timing is not a
real-provider latency or semantic quality result.

## Implementation order and acceptance

1. **Reproduce the handoff.** Pin PR head, inspect C1/C2 and clean status, read
   actual imports/configuration, and run the offline/stock checks below. Verify
   fixture/scorer locks before changing shared code. Record omitted checks.
2. **Approve a small deletion map in code review.** Inventory the table above,
   separate unused prototype code/settings from production paths, and choose
   the minimum supported B boundary. No automatic assumption that full strict
   enrollment is necessary. Do not expand user-facing configuration first.
3. **Simplify A and accounting.** Collapse duplicated state/configuration where
   justified, preserving durable call IDs, paid/unknown work, reservations and
   formal commit/failure behavior. Add regressions for persistence/lifecycle
   changes, not implementation-mirroring tests for a renamed helper.
4. **Prove B's carrier and boundary before enablement.** Build a finite official
   SDK experiment: original → tool candidate → native persistence → latest user
   steering → same writer → formal checkpoint → reopen. Include counterfeit
   source/permission labels, quoted-user data, cross-branch replay, revocation
   claims, malformed records, IO interruption and disabled/absent-candidate cases.
5. **Implement only that B loop.** One writer and one commit gate; optional
   bounded tool hints, no routine human-review flow. Compare session/fixed writer
   roles explicitly; fixed-writer B changes the preparation model role.
6. **Measure performance separately.** Establish complete source/proof identity,
   optimize one evidenced bottleneck, rerun S1 once for that new implementation,
   and report absolute/growth results separately. Stop at a finite declared call
   and time envelope.
7. **Compare A/B under matched controls.** Same sources, cuts, retained context,
   declared models/effort, whole-task costs and independent recovery probes.
   Include cold/stale/discarded/missing/failed candidates. Tiny scripted reuse is
   not full v0.4.0 acceptance; provider work needs its own authorized credentials
   and spending envelope. Update conclusions rather than relabel old evidence.

Use Node 22 (at least the package engine floor), then:

```sh
node scripts/context-memory-ops.mjs doctor
node scripts/context-memory-ops.mjs ci --acceptance-profile v0.4.0-preview.1-a-functional
```

`ci` is the complete maintained offline sequence: dependency/model-data setup,
stamp/offline build, focused and security checks, independent package build,
exact eight-component official Pi 1.1.0 and 1.0.4 installations, package acceptance,
default scenarios, release preparation and frozen scripted evaluation. Downloads
may be necessary; model calls are scripted/loopback only. Inspect every step's
exit code and the raw scenario/profile summary, not only the final process code.
Use `.github/workflows/context-memory.yml` as the command/order authority.

After an implementation change, declare and run the finite strict S1 comparison
below once, using fresh output directories. Install the second official cohort
before the complete suite. A nonzero performance exit must remain a recorded
failure; do not substitute the experimental profile when judging performance.

```sh
node scripts/context-memory-preview-stock-install.mjs --stock-root .artifacts/context-memory-preview-stock-1.0.4 --version 1.0.4
node scripts/context-memory-preview-scenarios.mjs --package-dir .artifacts/context-memory-preview-package --stock-root .artifacts/context-memory-preview-stock --output-dir .artifacts/cloud-next-s1 --only long-session-overhead --perf-checkpoints 20 --acceptance-profile strict
node scripts/context-memory-preview-scenarios.mjs --package-dir .artifacts/context-memory-preview-package --stock-root .artifacts/context-memory-preview-stock --other-stock-root .artifacts/context-memory-preview-stock-1.0.4 --output-dir .artifacts/cloud-next-full --perf-checkpoints 20 --acceptance-profile strict
```

For the performance-only worker, inspect `--help`/argument parsing in the bounded
scenario/component/latency runners and use outside-repository output directories.
Freeze the actual package/build and official cohort identities before execution.
Do not invoke the full upstream suite, `npm test`, or credential-triggered live
providers. Final publication remains a separate instruction, with final **main**
verification and CodeQL, clean committed source, immutable tags/assets, official
exact-package acceptance and truthful exception/benefit disclosure required.
