# Validation record

## v0.4.0-preview.1 PR and cloud handoff preparation

### Final clean C2 verification

`node scripts/context-memory-ops.mjs ci --acceptance-profile
v0.4.0-preview.1-a-functional` exits 0 on clean source commit
`1f7576e41639c616c683454e1687db859d6dd589` (C2). This is the single final
committed-artifact verification run, after source/pin maintenance; it is not a
retry of an unchanged S1 result to seek a pass. The documentation-only successor
records C2 evidence; any later publication must verify its own final clean source.

| Check | Result |
| --- | --- |
| Offline build, stamp and fingerprint | Exit 0; no generated source diff |
| Project static/dependency/import/type checks | Exit 0 |
| Self-contained script checks | 137 passed, zero failed/skipped |
| Focused runtime checks | 520 passed across 11 files |
| Synthetic host-security checks | 461 passed |
| Exact official Pi 1.1.0 package acceptance | 27 passed |
| Default scenarios with Pi 1.1.0 and 1.0.4 | 126 pass, one 50 ms known gap, zero fail/now-passes/skipped; raw `passed: true` |
| Preview release checks and local `--prepare` | Exit 0; no publication |
| Frozen scripted evaluator | 89 passed across 10 files; fixture/scorer locks unchanged |

The final C2 scenario uses 20 checkpoints, 70 loopback requests and the unchanged
nine-probe calculation. Growth passes in this run; the absolute target fails.
Earlier two growth failures below remain separate results on the same runtime.

| Milestone | Raw samples, ms | Rounded extension/control median | Extra overhead |
| --- | --- | ---: | ---: |
| 10 checkpoints | 52.409547, 46.291738, 58.420072 | 52 | 46 ms |
| 20 checkpoints | 89.836717, 109.522654, 90.022501 | 90 | 84 ms |
| Extension-disabled control | 10.516734, 5.610550, 4.713208 | 6 | — |

`84 <= 2 * 46` passes growth; `84 > 50` fails the absolute budget. The authorized
profile reports only the existing absolute known gap as an exception in this
run. No required growth failure was reclassified or omitted. Neither the new
pass nor the scope profile establishes stable pause/cost/recovery acceptance.

C2 package version is `0.4.0-preview.1`, runtime source/bundle remain a8fc/2c72
as recorded below, and exact archive SHA-256 is
`a38ed48d971c8eb1aeaa9317a335727e737384b9d1c34afce151d778d3e5c290`.
Manifest SHA-256 is
`34d92b2626da5db04ac5031d886f79dcb7c12150af72f37cd6a4d40bce253a8b`;
build metadata SHA-256 is
`5db76e897b7fda5a4a1fcdc57e05863c21cb6ea1dd1bc9e6524bbdb836739108`.
These identify C2, not a future source/package tag. No main update, merge,
tag, release, live-provider run or final-main/CodeQL success is claimed.

The maintainer selected an unmerged PR and cloud handoff as this session's
endpoint, with no tags, package-branch update or release. Arm A remains an
opt-in experiment; B remains disabled. The next worker may reassess or delete
the designs under the source/branch/disk/failure/cost constraints in the
[executable handoff](claude-handoff.md).

Only `v0.4.0-preview.1` has explicit approval for a functional experimental
acceptance scope. Its internal profile retains raw failed growth grading and
the 50 ms known gap; every other version and all non-performance requirements
remain unchanged. Full v0.4.0's A/B and performance requirements are not accepted
by this exception. Before the real C1/C2 and final clean-source run,
`node --test scripts/context-memory-preview-release-checks.test.mjs
scripts/context-memory-preview-acceptance-profile.test.mjs` exits 0 for 80
focused tests. Syntax and diff checks exit 0. This is policy/tooling verification,
not another performance measurement or final-main CI evidence.

The prior local `v0.4.0-preview.1` package passed 27 official-Pi package checks;
its production runtime source and bundle hashes match the hardened candidate
below. Final committed package metadata and archives must be rebuilt and checked
again after C1/C2. The PR description records those final commands and results;
no dirty-source archive is relabeled as a committed release artifact.

The real implementation C1 is
`2ccd555a26f42cae66c9eb76207e4caf63aa9d64`, based on
`e83a7bf8631c1d2d2e93a8d6e9676b1b39bc970c`. A separate maintenance change
advances `eval/runtime.ts` from its prior `96566c194654407450a8da3f5a18443516f283c6`
to C1. It changes no fixture/scorer lock or historical report. The prepared
resident build is `1.1.0-context-memory.0.3.0+src.3706b8258e544710`; its release
version remains v0.3.0. Earlier deliberately rejected uncommitted-fingerprint
runs below remain historical evidence, not a current frozen-gate failure.

## Unreleased authority bridge and public-API prototypes

The maintainer retained the v0.4.0 A/B target and authorized preparation of a
compatibility bridge with a minimum supported rollback reader. Released v0.3.3
is outside that authority-session rollback range. Release identities, strict
intake/projection and B remain unassigned or disabled. The prototypes below are
not imported by the production preview entry point.

### Bounded bootstrap on official Pi 1.1.0

`context-memory-authority-bootstrap.mjs` uses the actual public command →
`ctx.newSession({ setup })` path against the isolated eight-package official npm
cohort with networking denied. Approvals are a scripted UI, not authenticated
human acts. Script SHA-256 is
`249e80aeef6448f6a11d5c75e8ae803d442ee7e50c896b4ee2a68a9f076eda36`;
test SHA-256 is
`53588f320da7b91f2e38e5cf133e67d936d56d99a8c02b965269c9a9f02dc5d4`.
The final content-free v2 report SHA-256 is
`31f85615d4ccf08434d1317e77252acb3a893ab635ccc933540727e73737c52e`.
The earlier v1 report and its identity are retained separately.

| Command / evidence | Result |
| --- | --- |
| `node --test scripts/context-memory-authority-bootstrap.test.mjs` | Exit 0, five self-contained tests; no official installation needed |
| Same command with explicit `PI_AUTHORITY_BOOTSTRAP_STOCK_ROOT` | Exit 0, 13 tests, including actual official SDK lifecycle |
| Bootstrap CLI with explicit stock root and outside-repository report | Exit 0; all observed lifecycle/report-shape invariants checked |
| Provider/agent starts | Zero; eight runtime creations within the original cap |

Actual setup already contains `thinking_level_change/off`; a selected synthetic
model additionally produces `model_change` before it. The selected-model case
uses the public model option without provider registration, credentials or
transport. Both prefixes are source-free, linear, explicitly checked and bound
with the header hash; an empty/root-claim assumption does not hold.

Custom-only records remain buffered. Appending the genuinely reviewed original
user payload first flushes header/configuration/claim/source together; subsequent
receipt and fixture-seal records are separately read back. First-flush, receipt
and seal IO failures advance memory before disk confirmation and leave the
replacement runtime active, skipping `withSession`/rebind. Captured old context
and Pi closures are invalidated. Unsupported origin/mode, cancelled review and
review errors return `handled` through the actual input dispatcher. The fixture
seal is metadata, not an authority checkpoint; `pendingCounterDurable=false`.
This lifecycle experiment does not prove the ownership protocol, human origin,
ordinary-turn admission, provider projection, rollback or crash durability.

### Session-wide ownership primitive and public refusal hooks

The unused `PreviewAuthorityBridge` prototype publishes content-free ownership
metadata before the first approved source, binds canonical file/session/header
identity and the audited initialization prefix, and separately confirms original
claim/source/ownership-seal records. Its bootstrap helpers default off; its
reader refuses every owned state for dispatch, compact, retry, recovery, tree
and fork. An ownership state named `active` never authorizes a projection.
Sidecars are operational metadata, not another transcript. Bounds are 4 KiB per
barrier, 64 barriers, 128 directory entries, 64 MiB/250,000 original records and
128 KiB per reviewed source payload.

Focused checks pass 66 ownership tests and 13 event-guard tests. They cover
full initial-header binding, same-ID/file header changes, source/prefix changes,
missing/unknown barriers, interrupted publication, all-entry/sibling detection,
tokens from another manager, replay/recovery refusal and active ownership.
Ordinary multi-root trees and dotted session IDs retain their tested legacy
behavior; strict-owned second roots fail. Seal ancestry uses an invocation-local
ID index rather than a quadratic parent search.

One initial-failure limit is explicitly reproduced: after no barrier bytes have
been published, a new reader cannot see an old object's private latch and sees
an otherwise unmarked configuration prefix as legacy. The supplied setup caller
must append a bounded content-free incomplete-enrollment sentinel before
rethrowing. The unit remedy makes a replacement reader refuse without appending
a user source or pretending a custom-only flush. No persistence after a no-byte
storage failure is claimed; a complete product setup path is still required.

`context-memory-authority-guards.mjs --reader bridge` then runs the frozen
prototype through actual official SDK public events and the official
OpenAI-completions adapter, using an in-memory fetch transport with sockets
denied. It exits 0 for 21 expected classified cases and seven synthetic fetches
under the predeclared cap of eight. Four cases are legacy controls, 16 are
refusals and one is an explicitly unsupported warming-order counterexample.
Ten official host inputs have identical hashes before and after.

| Identity | SHA-256 |
| --- | --- |
| Guard CLI | `479a9944250527bc82eba4d550995c7ca7e4c6fff87b14ccc65e8d93423f4d42` |
| Guard CLI unit tests | `40e076052374252c883eeecce1d00945458939de49ff78572240804476c322f7` |
| Prototype source graph | `cf98d793c3a2dd6b09d1a556e7999fb72e86d6e653b1b76b459acce82bf9494d` |
| Temporary prototype bundle | `46f92e29aca830808e04e6bda3d28bc249067c77ec480f5b963e3d3447a954a5` |
| Real-reader SDK report | `af4d6aeace39983125a909707f8a46b90d752d386fe275eee58d0b5d18291e32` |

The valid active-ownership input is refused. Other deliberately unapproved
history fixtures become `tampered`, rather than being mislabeled valid pending
sessions. Each active request hook independently aborts; the final payload case
enters the actual adapter once and dispatches no fetch. Manual/threshold/overflow
compaction, tree summaries, fork and warming use their separate cancellation
mechanisms. Recovery tests are a command wrapper around a dummy marker/numeric
mutation, not actual production `PreviewFailureStore` recovery. Disabled tests
prove installation before the fixture's disabled return, not package integration.
Target-hook and after-first-request cases deliberately defer reader exposure to
isolate mechanisms; they do not authorize strict generation beforehand.

Stock warming is last-override-wins. A later handler can replace `stop`, which the
bounded handler-only negative records as unsupported ordering. A reviewed
extension set/final guard order remains necessary. The preliminary stub driver
failure (deny changed on a user event before its intended threshold request) and
earlier stub source snapshots are retained; the driver was corrected before the
final real-reader run. This evidence proves neither arbitrary extension ordering
nor complete intake/authority projection, fresh-process release compatibility,
source adoption, revocation or model obedience. These remain separate gates.

### Unified checks and unchanged production identity

The final `context-memory-ops.mjs verify` exits 1 solely at the deliberately
prepared resident-fingerprint gate. Offline build, project check and security
each exit 0: static/dependency/import/type checks, 57 self-contained Node tests,
520 focused runtime regressions and 461 synthetic host-security checks.
The new Node tests run before official cohort installation in CI; actual SDK
assertions require explicit separate invocation and never use the patched host.

Preview build exits 0 and produces exactly the previous `a8fcd0a35240f1fd` source,
bundle and archive identities listed below. Neither prototype is bundled. The
previous 27 exact-artifact stock package checks remain applicable; there is no
production-code delta requiring a new S1/S2 run. Both failed S1 runs below remain
release blockers. All 531 resident manifest files/content/diff match the prepared
candidate; the evaluation pin and fixture/scorer inputs remain unchanged. No
commit, push, release, full frozen CI pass or live-provider evidence is claimed.

## Unreleased v0.4.0 hardened readback candidate

The latest candidate is `stock-preview+src.a8fcd0a35240f1fd`, full source SHA-256
`a8fcd0a35240f1fdcf505e1cbbf6e3d7ca68120ffe4cd8143c8c243c26604d76`,
bundle SHA-256
`2c7259319766dddc4eb8a2f3964cc245e28242c1ec814e21954811054db389b1`,
archive SHA-256
`daa02fcc19b83e70428948e4521f7a3944ed6b766d3ee41ae11b428611b75314`.
Earlier artifacts and their failures below remain separate evidence.

Readback eligibility now verifies the complete allowed Array prototype chain and
the Object/Array prototype key/descriptor tables captured at module initialization.
A hidden inherited serializer can no longer escape the preflight. A named
prototype getter or inherited schema container could also mutate an earlier
source after prefix hashing, during successful TypeBox/note validation, and hide
that divergence through borrowed object identity. Both failures were reproduced
before this fix; any changed prototype contribution now disables borrowing for
the entire invocation. The baseline assumes trusted Node intrinsics and extension
helpers at initialization; it is not a sandbox against arbitrary local code or
global builtin rewrites. Ordinary parsing remains the compatibility fallback.

| Check | Result |
| --- | --- |
| `context-memory-ops.mjs verify` | Exit 1 solely for the deliberate prepared-fingerprint gate; offline build, project check and security each exit 0 |
| Project check | Exit 0: static/dependency/import/type checks, 42 Node tests and 441 focused runtime regressions, including 96 readback cases |
| Security check | Exit 0: 461 synthetic host checks |
| Preview package build | Exit 0: five package files; identities above; maintained release version remains unchanged |
| Official Pi 1.1.0 package acceptance | Exit 0: 27 checks on this exact artifact, with official host bytes unchanged |
| Standalone S1 | Exit 1: one pass, one 50 ms known gap and one required growth failure |
| Complete official Pi 1.1.0 / 1.0.4 scenarios | Exit 1: 125 passes, one 50 ms known gap, one required growth failure, no skips or unexpected passes |
| One `.2` component diagnostic | Exit 0: 70 loopback calls and nine original probes; diagnostic only |
| Four same-artifact S2 runs | Each exits 0: eight checkpoints and 24 independent scripted probes complete |

Resident stamp/content identity remains the authorized `3706b8258e544710`
candidate, with the existing 531-file manifest and frozen pin unchanged. No commit,
push, release, real-provider run or full frozen CI pass is claimed.

### Hardened S1: both unchanged growth checks fail

Both runs follow the same unchanged recipe and nine-probe calculation after
functional CPU checks ended, with preparation disabled and 70 loopback calls.
The full suite validates the actual implementation change; neither run was
repeated for a passing sample.

| Run / checkpoints | Extension median, ms | Disabled median, ms | Extra, ms | Raw extension samples, ms |
| --- | ---: | ---: | ---: | --- |
| Standalone / 10 | 65 | 8 | 57 | 68.770, 57.919, 65.187 |
| Standalone / 20 | 130 | 8 | 122 | 135.409, 111.520, 130.326 |
| Complete / 10 | 60 | 6 | 54 | 60.469, 52.173, 64.558 |
| Complete / 20 | 127 | 6 | 121 | 111.859, 127.042, 132.636 |

Controls were 9.198/7.694/5.703 ms standalone and 9.182/5.640/4.572 ms complete.
Session sizes remain 3.0/5.9 MB. Growth fails `122 > 2 * 57` and
`121 > 2 * 54`; 20-checkpoint overhead exceeds 50 ms in both. The required growth
check stays required, all failures stay recorded, and the equation is unchanged.
Neither timing differences from the earlier byte candidate nor these small
samples identify the causal effect of the prototype proof or establish tails.

One source-bound `.2` diagnostic was declared after the proof change to confirm
that the new gate had not silently disabled healthy canonical readback. All 141
hooks complete and their exclusive partitions close. All 8,460 serialized,
encoded, observed, disk, canonical and metadata records match; parses, canonical
misses and fallback hashes are zero. All six enabled probes contain the three
distinct hooks; disabled probes contain none. The prototype gate did not cause
fallback in this fixture.

At 20 checkpoints the three-hook/task exclusive means are 126.512 ms stringify,
25.427 ms SHA, 8.957 ms encoding, 14.405 ms plain-data proof, 16.889 ms disk read,
4.413 ms LF scan and 10.295 ms byte comparison. A 610.884 ms third probe strongly
skews those means; no independent CPU/GC evidence explains it. Retain all three
samples rather than discard that probe or infer algorithmic regression. This
instrumented result does not replace either failed S1 acceptance, and is not
pooled with `23dd`'s `.1` diagnostic.

### Hardened S2: complete reuse, mixed whole-task result

All runs share the artifact, unchanged working-tree snapshot, fixture/scorer and
declared readiness-wait policy from the measurement specification. Background
still overrides only the start interval to zero for the finite experiment.

| Writer / strategy | Paths | Pauses, ms | Chain wall, ms | All calls / synthetic tokens |
| --- | --- | --- | ---: | --- |
| Session / synchronous | sync, sync | 53, 72 | 2,285 | 17 / 399,481 |
| Session / background | complete, complete | 29, 48 | 1,853 | 17 / 399,481 |
| Fixed / synchronous | sync, sync | 63, 69 | 1,858 | 25 / 423,368 |
| Fixed / background | complete, complete | 31, 57 | 2,074 | 25 / 423,368 |

Readiness waits are 36/51 ms for session and 69/88 ms for fixed; ruling waits are
3/9 and 16/9 ms. All four complete background boundaries have zero foreground
writer calls. Session chain wall is lower and fixed chain wall is higher in this
set; the earlier byte candidate had higher background wall in both modes.
These single synthetic chains do not establish stable whole-task improvement.
All task, writer/preparation and ten probe provider calls per run are included;
cache-write, reasoning and billing remain unknown. Natural hit rate, provider
cache economics, semantic recovery, instruction authority and B remain untested
or gated. The roadmap acceptance is incomplete.

## Unreleased v0.4.0 byte-readback candidate

The byte-readback candidate is `stock-preview+src.cc4ee46f242d67c4`, full source
SHA-256 `cc4ee46f242d67c4dc23697fcdf88f1d2fb936e607b5d6f3bd47c8dcd39b150c`,
bundle SHA-256
`1f0d59023e09a53296756156fa8060026216959a66bf90a70b272543d37f0c5e`,
archive SHA-256
`1c6c11321126245f66447d677392d0eca4ab1c9eaea26f2483dc092ea621d95a`.
It replaces full-file decoded strings and canonical string-map lookup with fresh
bounded Buffer readback and sequential byte comparison. Exact selected-ancestor
records borrow proven branch objects; siblings and noncanonical records still
parse and receive all metadata/parent checks. A noncanonical selected record
advances the ancestor cursor but preserves the independent branch-hash fallback.

The whole-branch factory proof additionally requires own enumerable serializable
entry metadata. Hidden/inherited metadata and nonfinite parent IDs retain legacy
parse semantics through fallback. Nested ordinary nonfinite/undefined values do
not gain a new storage meaning. Ninety focused readback cases cover Unicode,
lone surrogates, malformed-byte lossy decoding, CRLF/BOM/blank/truncated records,
entry-limit error order, interleaved siblings, complete owned collection and
fresh file/marker checks.

| Check | Result |
| --- | --- |
| `context-memory-ops.mjs verify` | Exit 1 only for the authorized changed-fingerprint gate; offline build, project check and security steps exit 0 |
| `context-memory-check.mjs` | Exit 0: static/dependency/import/type checks, 42 Node checks and 435 focused runtime regressions |
| `security-regression-check.mjs` | Exit 0: 461 synthetic host security checks |
| `context-memory-preview-build.mjs` | Exit 0: five independent package files, source/bundle/archive identities above |
| Official Pi 1.1.0 preview acceptance | Exit 0: 27 package/lifecycle checks; official CLI/SDK/runner/storage bytes unchanged |
| Standalone S1, 20 checkpoints | Exit 0: two required passes and the remaining 50 ms known gap |
| Complete scenarios, official Pi 1.1.0 / 1.0.4 | Exit 1: 125 passes, one 50 ms known gap and one required growth failure; no skips or unexpected passes |
| Four same-artifact S2 runs | Each exits 0; eight checkpoints and 24 independent synthetic probes complete |

The 531-file resident content and diff manifests remain byte-identical to the
authorized `3706b8258e544710` shared candidate. `eval/runtime.ts` and tracked
evaluation inputs remain unchanged. Earlier frozen-runtime rejection still
applies; no implementation commit, pin advancement or full frozen CI pass is
claimed. No real-provider endpoint or credentials were used.

### Byte S1: unchanged targets remain incomplete

Both runs occurred after CPU checks finished, with preparation disabled and the
unchanged source recipe, nine probes, median calculation and 70 synthetic HTTP
calls. The complete suite is a required whole-suite check after the implementation
change, not a retry of the standalone result.

| Run / checkpoints | Extension median, ms | Disabled median, ms | Extra, ms | Raw extension samples, ms |
| --- | ---: | ---: | ---: | --- |
| Standalone / 10 | 50 | 8 | 42 | 49.913, 43.372, 53.471 |
| Standalone / 20 | 90 | 8 | 82 | 89.658, 123.101, 87.539 |
| Complete / 10 | 51 | 5 | 46 | 51.135, 49.278, 63.556 |
| Complete / 20 | 116 | 5 | 111 | 115.769, 131.379, 115.677 |

Control samples were 8.919/7.754/5.493 ms standalone and
5.915/4.717/4.428 ms in the complete suite. Session sizes remain 3.0/5.9 MB.
The standalone growth check passes (`82 <= 2 * 42`), while the complete check
fails (`111 > 2 * 46`). Keep this failure and the preceding candidate's failure;
do not restore the old known-gap entry, change the equation or rerun for a pass.
Lower observed byte-candidate timings do not establish a stable improvement or
latency distribution. The 50 ms gate has not passed.

The component instrumenter was updated to schema `.2` for this byte source;
its script SHA-256 is
`d8ac0fdab5603be83f46e31b65b89c1a9d6d5d8090c877b52259b6772507f722`.
Fifteen Node regressions pass, including transformed Unicode byte counts,
encoding/comparison/scan stages and exclusive partition closure. No actual `.2`
component worker was run; the executed `.1` diagnostic below retains its own
artifact and cannot be pooled with this candidate.

### Byte S2: path reuse and whole-chain cost

All four runs use the frozen S2 fixture and scorer, one unchanged working-tree
snapshot and the same `cc4ee46f242d67c4` bundle. The declared background policy
sets `minIntervalMs: 0` and waits for readiness; it does not measure natural hit
rate or the default five-second scheduling interval.

| Writer / strategy | Paths at two boundaries | Pauses, ms | Chain wall, ms | All calls / synthetic tokens |
| --- | --- | --- | ---: | --- |
| Session / synchronous | sync, sync | 64, 85 | 2,167 | 17 / 399,481 |
| Session / background | complete, complete | 34, 86 | 3,005 | 17 / 399,481 |
| Fixed / synchronous | sync, sync | 78, 106 | 2,177 | 25 / 423,368 |
| Fixed / background | complete, complete | 35, 54 | 3,198 | 25 / 423,368 |

Background readiness waits after trace turns were 46/68 ms for session and
71/106 ms for fixed; ruling waits were 5/19 and 3/8 ms respectively. Complete
reuse makes zero foreground writer calls at all four background boundaries, but
whole-chain wall time is higher in both background runs. All task, preparation,
foreground and ten probe provider calls per run are included. Both strategies
have equal synthetic token totals within each writer mode; this is an interface
fixture, not provider savings or semantic recovery evidence. Cache-write,
reasoning and billed cost are unknown for every raw synthetic call. These four
runs do not establish the roadmap's whole-task performance or provider-quality
acceptance, and arm B remains gated.

## Unreleased v0.4.0 request safety and component diagnostic

This continuation first produced `stock-preview+src.23dd80bdccc4efa4`, full
preview source SHA-256
`23dd80bdccc4efa4f74b3c7e15c4b33ff0137cf6e5f1a80b86030981a28b7256`,
bundle SHA-256
`daa33d9fd58c8a792fb0f297b4ef4360f2daaf8cf776df2e662cb578d82dd769`,
archive SHA-256
`fd580d61f8ecd39b582e31a0620097a5f7823f908b9cfee25eb573eb032b0c40`.
The resident candidate and unchanged evaluation pin below remain separate.

Readback reuse now requires a complete factory-owned snapshot, with a
side-effect-free plain-data proof of the entire branch before serialization.
Per-entry checking was insufficient: a later entry's serializer/accessor could
mutate an earlier borrowed object and mask divergence from its saved line.
Focused regressions reproduced that failure before the fix. Serialization hooks,
accessors, proxies and sparse arrays disable reuse for the whole invocation;
inherited indexed accessors also disable the proof before its own array operations.
Unbranded, incomplete and previously consumed snapshots take independent ordinary
parsing and hashing. No request cache is introduced.

A cheap preparation rejection now consults only owned bounded accounting before
constructing a large snapshot. It skips exhausted intervals, in-flight work and
known accounting gaps. An absence of rejection never permits dispatch: start
and each durable per-call reservation still reread the ledger. Regression cases
change the ledger after each cheap/start check and verify rejection before a
provider call. New confirmed checkpoints permit a new interval; paid failed or
invalidated work remains charged.

Focused readback, ledger/coordinator and controller suites exited 0 with 53, 80
and 79 checks respectively; the subsequent type check exited 0. These were
functional checks, not complete stock-Pi acceptance or new S1/S2 results.

One finite `context-memory-preview-request-profile.mjs` diagnostic then exited 0:
20 checkpoints, 70 synthetic loopback calls, nine original probes and all
temporary session copies deleted after content-free reports were retained. Its
script SHA-256 was
`84d42d07947b44be1131cb1a71aec322fd9a7127e8195b89bace59e3193b2068`.
The instrumenter builds baseline and temporary instrumented packages from one
verified source snapshot and checks the baseline bundle against the artifact.
Its 14 focused Node regressions exited 0. Instrumentation was not included in
the production package or the S1 acceptance calculation.

Six enabled probes each contain all three distinct request hooks; the three
disabled probes contain none. The three hooks per probe have identical counts:
56/58/60 branch entries at 10 checkpoints and 112/114/116 at 20. Each entry is
serialized, hashed, observed, found on disk, matched canonically and metadata
checked exactly once per hook. Canonical misses, entry parses and fallback branch
hashes are zero in this fixture. Exclusive partitions plus unattributed time
close exactly against each hook's wall time.

| Exclusive component, three hooks per task at 20 checkpoints | Mean wall time, ms |
| --- | ---: |
| JSON serialization | 48.265 |
| SHA update and prefix boundaries | 17.971 |
| Whole-branch plain-data proof | 6.854 |
| Fresh full-file read | 6.905 |
| Full-file UTF-8 decode | 5.200 |
| Line split | 1.524 |
| Canonical string lookup | 3.922 |
| Observer string map | 1.326 |
| Entry metadata checks | 0.538 |

Observer collection, decoding, split and lookup provide approximately 11.973 ms
of gross opportunity per task for a bounded byte-readback experiment. New encoding,
allocation, scanning and byte comparison costs must be deducted; this does not
support a 50 ms claim. The instrumented 49/97 ms overhead values are diagnostic,
not acceptance replacements for the preceding candidate's 134/289 ms failure.
Timed components include scheduling/GC effects and instrumentation overhead.
`serializedCodeUnits` is UTF-16; `diskBytes` is actual UTF-8. This ASCII fixture
does not establish arbitrary Unicode or malformed-byte equivalence.

The [authority](instruction-authority-design.md) and
[historical-prefix](historical-prefix-design.md) proposals are design evidence
only. Neither activates arm B, retained-tail submission, a new checkpoint format
or live model work.

## Unreleased v0.4.0 shared validation candidate

This section records the earlier `ea81dc8b879deca2` artifact and its actual
failures. It does not describe validation of later preview revisions.

The maintainer authorized preparing shared validation and corresponding runtime
identity changes for review, without committing, pushing or publishing. Shared
`hashEntryPrefixes` and `validateMemoryCheckpoints` now validate all preview
checkpoints with one ordered serialization/hash pass and invocation-local source
indices. The established hash bytes and schema/quote/supersedes/budget/rendered
summary checks remain unchanged; public `latestMemory` retains latest-only
behavior. Every preview request hook still validates independently.

Within one synchronous request guard, freshly serialized canonical lines are
passed directly to disk readback. The store still reads the complete JSONL and
fresh failure marker, validates every entry's metadata, duplicate/root/parent
rules and selected branch, and only reuses objects for exact plain-data lines.
Noncanonical lines, serialization hooks, getters, proxies and other non-plain
objects take the previous parse/hash path. Both snapshot and map are single-use.
Status, inspection, staging and commit confirmation retain independent readback.
There is no cross-hook/request cache or intervening asynchronous dispatch.

The candidate resident stamp is
`1.1.0-context-memory.0.3.0+src.3706b8258e544710`; its full source hash is
`3706b8258e54471030d480108f56bab306759bd2586052ab64357591966f3402`.
The preview artifact is `stock-preview+src.ea81dc8b879deca2`, bundle SHA-256
`bd458671b23b0b7868897c36f7db7dda28efa364d3963ebc191f163bf714da3c`,
archive SHA-256
`af62ee9900a487456d0854d1ee1a4c7b9932b7c259d3301beb93f932201132c1`.
Version strings are unchanged. The local ignored candidate manifest records
531 resident files, runtime-content SHA-256
`b4ef84bbd4813a75fcc9b66aef53e97c1a5ce4e9ab87102ec393e54377e9ef63`,
the stamp/diff identities and the unchanged frozen fixture/scorer hash.

| Check | Observed result |
| --- | --- |
| `context-memory-ops.mjs verify` | Exit 1 solely for the deliberate changed-fingerprint gate; offline build, project checks and security checks each exit 0. The candidate stamp was prepared under maintainer authorization; no commit or gate bypass was made. |
| `context-memory-check.mjs` | Exit 0: static/import/dependency/type checks, 27 Node checks and 368 focused regressions: 94 resident, 76 preview controller/lifecycle, 31 candidate, 27 ledger, 28 writer calls, 40 coordinator/config, 33 shared validation and 39 readback. |
| `security-regression-check.mjs` | Exit 0: 461 synthetic host security checks. |
| Offline `eval/pi/preflight.test.ts` and `eval/runner/frozen.test.ts` | Exit 0: nine checks, including all twelve declared fixture arm/checkpoint combinations with disk reopening. `EVAL_WRITE_PREFLIGHT=0`; frozen fixtures were not rewritten. |
| Direct `assertFrozenInputs()` with the current pin | Exit 1: `EVAL_FROZEN_INPUT_CHANGED:96566c194654407450a8da3f5a18443516f283c6`. This is an actual rejection of the uncommitted shared candidate, not a passed frozen evaluation. |
| `context-memory-preview-build.mjs` | Exit 0: the candidate identity above, five independent package files and no bundled host runtime. |
| `context-memory-preview-acceptance.mjs` on official Pi 1.1.0 | Exit 0: 27 package/lifecycle checks; official CLI/SDK/runner/storage bytes unchanged. |
| Standalone `context-memory-preview-scenarios.mjs --only long-session-overhead --perf-checkpoints 20` | Exit 1: one pass, one remaining 50 ms known gap and one previously listed growth gap now passing. All 20 checkpoints committed; the growth check was then promoted to required. |
| Complete `context-memory-preview-scenarios.mjs` on official Pi 1.1.0 / 1.0.4 | Exit 1: 125 passed, one 50 ms known gap, one required growth failure, zero unexpected passes or skips. All 20 S1 checkpoints committed. |

An initial preflight invocation omitted its required scratch-directory setting
and failed before the lifecycle check. The corrected declared offline invocation
passed the nine checks above. Package acceptance was also initially invoked with
a nonexistent output-package directory; the corrected builder-reported directory
passed. These setup failures are not accepted comparison runs.

### S1 final candidate: performance acceptance incomplete

Both runs used the same built artifact, preparation disabled, official Pi 1.1.0,
the unchanged nine-probe median calculation and 70 loopback HTTP requests
(50 task, 20 writer). The standalone run finished after other CPU checks; the
complete scenario suite then reran S1 to verify the deliberate promotion of the
growth check. The runner retained all raw samples and monotonic probe intervals.

| Run / checkpoints | Session MB | Extension median, ms | Disabled median, ms | Extra overhead, ms | Raw extension samples, ms |
| --- | --- | --- | --- | --- | --- |
| Standalone / 10 | 3.0 | 56 | 7 | 49 | 50.344, 55.830, 56.400 |
| Standalone / 20 | 5.9 | 100 | 7 | 93 | 95.801, 152.956, 100.433 |
| Complete suite / 10 | 3.0 | 148 | 14 | 134 | 147.932, 151.049, 146.668 |
| Complete suite / 20 | 5.9 | 303 | 14 | 289 | 303.217, 273.409, 328.161 |

Disabled-control samples were 12.631/4.380/6.947 ms standalone and
25.651/13.959/9.972 ms in the complete suite. Standalone growth passed
(`93 <= 2 * 49`), but the promoted required check failed in the complete suite
(`289 > 2 * 134`). That failure remains visible; the known-gap entry was not
restored and neither calculation nor threshold was changed. No run was repeated
solely to obtain a pass.

Both final runs show lower observed request overhead than the earlier opt-in
baseline below, but they do not meet the 50 ms target or establish stable growth.
Three probes per milestone, with one extension-disabled control at the end,
cannot establish a latency distribution, prove superlinear complexity or identify
CPU contention as the cause. The current source removes the old repeated prefix
scan; substantial serialization, allocation, map, full-file readback and context
checks still occur independently in all three hooks.

A prior whole-chain CPU profile informed the readback change, but also included
compaction work and did not retain usable probe alignment. It is diagnostic
evidence, not a request-phase attribution or acceptance result.

One subsequent diagnostic was declared in the measurement specification and ran
the unchanged final worker after other CPU tasks finished: 20 checkpoints, 70
loopback HTTP calls, a 180-second deadline, a 1,000-microsecond Node CPU profile
and GC trace. It exited 0 and retained the profile/result before scratch cleanup.
Its instrumented timings do not replace either acceptance run above.

The profile's monotonic timestamps aligned directly with all nine original probe
intervals; enabled intervals contained the expected extension stacks, and the
disabled control contained none. Within the three probes at each milestone:

| Milestone | Total probe wall, ms | Prefix/hash inclusive sampled time, ms | Readback inclusive sampled time, ms | GC sampled time, ms |
| --- | --- | --- | --- | --- |
| 10 checkpoints | 171.914 | 96.801 (56.3%) | 29.382 (17.1%) | 0 |
| 20 checkpoints | 1,024.271 | 518.874 (50.7%) | 216.440 (21.1%) | 127.064 (12.4%) |
| Disabled control | 66.284 | 0 | 0 | 0 |

These are weighted CPU-stack samples, not exact process CPU accounting;
inclusive categories must not be summed with their child/self measurements.
Native stringify and Map operations can be attributed to their caller, so this
profile cannot precisely separate those components. No `hashEntries` stack was
sampled inside the nine probes, consistent with canonical readback avoiding the
extra disk/memory branch hashes. Serialization/prefix hashing and file processing
remain the main sampled extension costs.

Two 20-checkpoint probes contained approximately 84.9/42.2 ms of sampled GC,
corroborated by major pauses in the separate GC log. The third had no GC sample
and still took 281.7 ms, so GC does not explain all remaining cost. The GC log's
relative clock requires an inferred startup offset and is only corroboration;
the CPU profile provides probe alignment. Sampling gaps reached 14.9 ms, and
IO, scheduling and profiling can affect weights. This diagnostic cannot assign
the exact cause of the earlier unprofiled failure or establish complexity.

Before changing the algorithm again, collect bounded component timing and
operation counts to distinguish serialization, string-map construction, bytes
read/decoded, canonical/fallback paths and allocation/GC. See the
[remaining P1 investigation](v0.4.0-plan.md#p1-reduce-repeated-request-validation).

### S2 final candidate: reuse works, time benefit unestablished

Four fresh `context-memory-preview-latency.mjs` chains ran sequentially on the
same final artifact and official Pi 1.1.0 cohort. The unchanged recipe SHA-256
was `4a1db2d1f9628fc51245d66ba0f2dde913d219085b955e09f334130ad49718a2`.
The explicit preparation policy retained the 2,048-token trigger and default
budgets, with `minIntervalMs: 0` for this finite experiment. Each chain used five
task requests, two checkpoints and six independent fresh-process probes.

| Writer / strategy | Manual pauses, ms | Chain wall, ms | Writer calls: preparation / foreground | Total HTTP calls |
| --- | --- | --- | --- | --- |
| session / synchronous | 60, 63 | 2,033 | 0 / 2 | 17 |
| session / background | 78, 143 | 5,877 | 2 / 0 | 17 |
| fixed / synchronous | 77, 81 | 2,052 | 0 / 10 | 25 |
| fixed / background | 53, 107 | 2,649 | 10 / 0 | 25 |

All four commands exited 0. Eight checkpoints were confirmed on disk, all 24
scripted source/permission/action probes passed, and each probe group used 1/1/3
requests without a forbidden or repeated action. Both background chains selected
`complete` twice and made zero foreground writer calls; the synchronous chains
selected `sync`. All paths kept zero raw tail and serialized notes of 624/657
bytes. Same-writer stale merge retains focused regressions, without a measured
stock-Pi S2 sample in these four chains.

Read-only readiness polling forced complete candidates before submission. Trace
waits were 81/160 ms for session and 114/121 ms for fixed; earlier ruling polls
were 4/31 ms and 3/12 ms. They are included in chain wall time. This is controlled
reuse evidence, not a natural hit-rate estimate. Background did not show a
stable pause improvement, and both background chain wall times exceeded their
matched synchronous observations. One chain per combination cannot attribute
the differences to environment, shared validation or preparation overhead, nor
support an overall latency benefit. These results do not meet the roadmap's
performance acceptance; the default remains synchronous.

Within each writer mode, HTTP counts and synthetic tokens were identical across
strategies: 399,481 for session and 423,368 for fixed, including probes. The two
preparation ledgers retained 2/10 reused calls, zero discarded calls, complete
SDK-normalized observations and no accounting gaps. This construction does not
measure naturally wasted preparation. Raw cache-write, reasoning and billed
cost were absent in every synthetic response and remain unknown in the reports;
catalog estimates and SDK zeros do not prove economic savings. No real model
quality, provider cache behavior or live billing was evaluated. Scratch
transcripts/settings/markers were removed; retained evidence is content-free.

### Identity handoff and remaining gates

The evaluation pin remains
`96566c194654407450a8da3f5a18443516f283c6`; `eval/` has no modifications and the
fixture/scorer content lock remains `6d19b38a…`. A working-tree content hash is not
a Git commit pin. The maintainer must first create implementation commit C1 with
the reviewed runtime, regressions and generated stamp, then update
`eval/runtime.ts` to C1 in separate maintenance commit C2. Preserve fixture/scorer
bytes and historical report identities; a squash must retain or reestablish a
real pin target. Full frozen evaluation and complete CI have not passed this
uncommitted candidate.

Preparation remains disabled by default. The performance gates, natural candidate
hit rate, live cache/cost/recovery evidence, historical-prefix contract and arm B
authority/comparison gates remain incomplete. No provider credentials or live
model were used, and no release or publication was prepared.

## Unreleased v0.4.0 opt-in integration before shared validation

The preview development runtime now imports the preparation coordinator. It is
disabled by default; enabling `previewPreparation` schedules the configured
writer after settled text turns. Complete candidates use zero foreground
writer calls, source-valid stale candidates use the same writer for a merge,
and other cases use synchronous compaction. Every path keeps full-branch
coverage and the existing pending/stage/append/disk-read confirmation gate.
The resident fingerprint, frozen evaluation pin and version strings are
unchanged. Historical-prefix submission and arm B remain inactive.

The content-free ledger records reservations before dispatch, separate
preparation/foreground observations, optional cache/reasoning breakdowns and
reuse/discard/supersede disposition. Interrupted default-zero usage stays
unknown; positive interrupted usage is a lower bound until a complete report
arrives. A staged disk claim survives shutdown until recovery. New preparation
failure, cancellation or accounting pause cannot create a compaction failure
marker or abort an ordinary task.

| Check | Observed result |
| --- | --- |
| `context-memory-ops.mjs verify` on the final integration source | Exit 0: offline build, complete project checks and host security checks; resident fingerprint gate passed. |
| `context-memory-check.mjs` after integration | Exit 0: static/dependency/import/type checks, 27 Node checks and 295 project regressions (94 resident, 75 preview controller/lifecycle, 31 candidate, 27 ledger, 28 writer calls and 40 coordinator/config). |
| `security-regression-check.mjs` | Exit 0: 461 synthetic host security checks. |
| `eval/runner/frozen.test.ts` | Exit 0: eight frozen-input/preview-separation checks. |
| `context-memory-preview-build.mjs` | Exit 0: integrated source identity `stock-preview+src.5ac8e318721e7203`, five package files, no bundled host runtime. |
| `context-memory-preview-acceptance.mjs` on official Pi 1.1.0 | Exit 0: 27 package/lifecycle checks, source tampering, failed writes/cancellation and staged recovery included; official host file bytes unchanged. |
| `context-memory-preview-scenarios.mjs` on official Pi 1.1.0 / 1.0.4 | Exit 0: 125 passed, two known performance gaps, zero failures/unexpected passes/skips. All 20 S1 checkpoints committed. |

Integration regressions additionally exercise latest user rulings, custom
focus, paid malformed output, no pending marker during preparation, zero-call
full coverage, same-writer tail merging with referenced originals, exact disk
confirmation, restart/staged recovery, multiple attempts over identical inputs,
unknown/partial usage and corrupt accounting isolation. All services remain
scripted/loopback or network-denied; no live provider was called.

The first unified verification stopped on formatting in a newly edited test;
formatting was corrected. A subsequent deadline regression expected complete
usage from an interrupted stream; the new completeness rule correctly reported
it as partial, and the assertion was updated to require visible unknown usage
and cost. These failed runs are not accepted comparisons.

### S1 request baseline on the integrated artifact

The standalone default-settings suite ran after the other checks and S2 chains
finished. Preparation was disabled. Its manifest records the artifact source
identity, runner hash and the complete official host cohort; the runner now
retains the original nine timing samples without changing its median calculation.
The run made 70 HTTP requests: 50 task requests and 20 session-writer calls.

| Checkpoints | Session MB | Extension median, ms | Disabled median, ms | Extra overhead, ms | Raw extension samples, ms |
| --- | --- | --- | --- | --- | --- |
| 10 | 3.0 | 278 | 11 | 267 | 278.450, 317.274, 268.444 |
| 20 | 5.9 | 1,571 | 11 | 1,560 | 962.189, 1,570.855, 1,908.630 |

Disabled-control samples were 17.924, 10.698 and 8.105 ms. Both the 50 ms target
and growth bound remain known gaps. The 20-checkpoint samples varied widely;
this run establishes neither a reliable tail estimate nor unchanged performance
against the earlier foundation median. Shared request validation was not changed,
and moving generation off `/compact` does not address this request-side cost.

### S2 matched synthetic execution

Four fresh chains ran sequentially on the same official Pi 1.1.0 installation
and artifact `stock-preview+src.5ac8e318721e7203`. Each chain used five task
requests, two manual checkpoints and six independent fresh-process probes.
The fixture SHA-256 was
`4a1db2d1f9628fc51245d66ba0f2dde913d219085b955e09f334130ad49718a2`;
bundle SHA-256 was
`bcdc32270ea1df5d810d0ed85842784d3fe2c1cd2aa21f18a983b728f33fb856`.
The experiment policy retained the runtime budgets and 2,048-token trigger,
with an explicit zero minimum interval for this finite synthetic run.

| Writer / strategy | Manual pauses, ms | Chain wall, ms | Writer calls: preparation / foreground | Total HTTP calls |
| --- | --- | --- | --- | --- |
| session / synchronous | 44, 57 | 1,819 | 0 / 2 | 17 |
| session / background | 25, 52 | 1,967 | 2 / 0 | 17 |
| fixed / synchronous | 71, 76 | 2,120 | 0 / 10 | 25 |
| fixed / background | 31, 52 | 2,073 | 10 / 0 | 25 |

All four commands exited 0. Eight checkpoints were confirmed on disk, all 24
scripted source/permission/actual-action probes passed, and no probe repeated
completed work or took a forbidden action. Each probe group made 1/1/3 provider
requests; the action probe executed one permitted action and read originals.
All paths retained zero raw tail; serialized notes were 624 and 657 bytes.
Each background boundary selected `complete`; both synchronous boundaries
selected `sync`. The stale merge path has focused regressions, not a measured
stock-Pi S2 timing sample in these four runs.

Background runs waited for readiness through read-only status commands before
manual submission. Trace readiness waits were 36/52 ms for session and 70/84 ms
for fixed, included in chain wall time. This construction establishes complete
reuse under controlled timing; it cannot estimate natural full-candidate hit
rate or a pause distribution. Chain wall time changed in different directions;
one chain per combination supports no overall task-time improvement claim.

Within each writer mode, total HTTP calls and returned synthetic tokens were
identical: 399,481 tokens for session and 423,368 for fixed, including task,
writer and probe calls. Preparation therefore moved work from the commit
boundary; these runs show no token savings. The two preparation ledgers retained
2 and 10 reused calls, zero discarded calls, no observation gaps, and 2,668 /
9,525 bytes of content-free state. This does not exercise natural wasted work;
the failure/restart/multiple-attempt regressions cover its lifecycle.

Ledger completeness refers to Pi SDK-normalized usage and catalog estimates,
not provider billing or availability of every raw cache/reasoning field. The
raw synthetic responses did not report cache-write, reasoning or billed cost;
the S2 report keeps those fields unknown. SDK zero defaults and zero catalog
prices do not demonstrate cache hits, free preparation or live cost savings.
No model semantics, paid-provider behavior, 50 ms request acceptance or full
arm A/B release comparison was evaluated. Scratch transcripts/settings/markers
were removed; only content-free evidence remains outside the repository.

### Foundation baseline before integration

At the initial foundation checkpoint, the work added candidate freeze/finalize/classification and bounded
preparation accounting modules, but the preview entry did not import them.
There was no background provider dispatch, prepared checkpoint submission or
new user-facing configuration/status behavior. That independent runtime was
`stock-preview+src.9ca9dd2123d49293`; the resident fingerprint and
`eval/runtime.ts` pin were unchanged. See the [plan](v0.4.0-plan.md) and
[measurement specification](v0.4.0-measurement.md).

Local validation used Node 24.19.0; CI remains on Node 22. All services were
scripted/loopback or network-blocked. No real provider credentials or model
service were used. Official test installations use all eight Pi runtime packages
at 1.1.0, with a separate complete 1.0.4 cohort for the other-host case.

| Command | Result and scope |
| --- | --- |
| `node scripts/context-memory-ops.mjs verify` | Exit 0: offline build, static/dependency/import/type checks, 20 Node checks, 218 context regressions at that revision and 461 host security checks. Subsequent ledger refinements are covered by the latest targeted checks below. |
| `node scripts/context-memory-check.mjs` on final foundation sources | Exit 0: all static/dependency/import/type checks, 20 Node checks and 220 context regressions (94 resident, 69 existing preview, 31 candidate and 26 ledger cases). |
| `npm run build --workspace @earendil-works/pi-coding-agent` after the final ledger changes | Exit 0: unbundled source and host bundle rebuilt; no source identity changes. |
| Scoped Biome, `tsc --noEmit`, and `vitest` for `context-memory-preview-ledger.test.ts` | Exit 0 on the final ledger source: 26 passed. The candidate suite separately passed 31 checks. |
| `vitest` for `eval/runner/frozen.test.ts` | Exit 0: eight frozen-runtime/preview-separation checks. |
| `node --test scripts/context-memory-prefix-profile.test.mjs scripts/context-memory-preview-stock-install.test.mjs` | Six kernel checks and 14 installer checks are included in the acceptance command above. They use synthetic inputs, mocked npm execution or network-denied SDK imports. |
| `context-memory-preview-stock-install.mjs --check` for each official installation | Exit 0 for 1.1.0 and 1.0.4: all eight versions/integrity records match and SDK startup passes with networking denied. |
| `node scripts/context-memory-preview-build.mjs` | Exit 0: five package files, unchanged runtime source identity. The new preparation modules are not bundled. |
| `context-memory-preview-acceptance.mjs` with the isolated official Pi 1.1.0 installation | Exit 0: all 27 existing package/lifecycle checks, including fresh-process reopening and staged recovery. Official host file bytes remained unchanged. |
| `context-memory-preview-scenarios.mjs` with both official installations | Exit 0 on a standalone run: 125 passed, two known gaps, zero failures, zero unexpectedly passing gaps and zero skips. |
| `git diff --check` and design-document relative-link checks | Exit 0. |

Full `context-memory-ops.mjs ci`, release preparation and provider evaluation
were not run. The checkout remains uncommitted and no release assets, runtime
pins or fingerprints were advanced.

The candidate regressions cover frozen snapshots/output, same-leaf source edits,
cross-branch/session identity, new user rulings, stale prefix reuse classification,
future citations/supersedes, quotes, actual writer identity and submission budget
bounds. The ledger regressions cover durable dispatch reservations, restart
orphans, cancellation, duplicate/cumulative reporting, late usage, rotation,
quotas, corrupt/oversized records and IO failures. Candidate IDs interoperate
with the ledger; equivalent policy field orders reopen the same state. Missing
reasoning breakdowns remain unknown, and mixed cost sources are identified.

The first stock installation attempt pinned only `pi-coding-agent@1.1.0`; its
caret dependencies resolved several Pi components to 1.2.0. Acceptance and the
overhead scenario stopped at an SDK import failure because the selected
`pi-codemode/declarations` did not export `MCP_TYPESCRIPT_PREAMBLE`. Both exited 1.
The new shared installer fixes test setup by pinning the official component
cohort and checking metadata plus SDK startup; no host file is patched.

An intermediate build exited 2 on an excessively deep recursive readonly type
in the new candidate module. Explicit bounded readonly interfaces corrected it;
the subsequent build and type checks passed.

A preliminary overhead run was incorrectly concurrent with other verification
work. All 20 checkpoints committed, but its 10-checkpoint measurement was 603 ms
and its 20-checkpoint measurement was 963 ms, with a 5 ms disabled control. The
growth gap unexpectedly passed, so the runner exited 1. That run is retained as
interfered evidence, not a fixed gap or an accepted comparison. The standalone
full-scenario run after other checks ended produced this S1 baseline:

| Checkpoints | Session size | Extension request median | Disabled control median | Extra overhead |
| --- | --- | --- | --- | --- |
| 10 | 3.0 MB | 310 ms | 7 ms | 303 ms |
| 20 | 5.9 MB | 966 ms | 7 ms | 959 ms |

All 20 manual checkpoints committed. The 50 ms overhead target and the growth
bound both remain known gaps. These timings use three probes per milestone and
three disabled-control probes in one session; they are not reliable tail
estimates, model latency, or preview recovery-quality measurements.

The separate `node scripts/context-memory-prefix-profile.mjs` prototype exited 0.
It compares the current hash byte rule to single-pass SHA-256 copies at prefix
boundaries on synthetic records. For 10/20/60 boundaries it generated
1,000/2,000/6,000 entries with 512-byte text, about 0.68/1.35/4.07 MB serialized.
Every requested boundary hash matched. Three timing samples per case were:

| Boundaries | Repeated-prefix samples in ms | Single-pass samples in ms |
| --- | --- | --- |
| 10 | 12.676, 10.763, 11.458 | 2.205, 2.116, 2.753 |
| 20 | 49.717, 55.191, 52.414 | 4.992, 4.684, 4.399 |
| 60 | 450.401, 473.697, 433.054 | 12.201, 12.362, 18.450 |

These are kernel-only measurements. They exclude disk readback, schema/quote
validation, session traversal and the three request hooks. They do not establish
the 50 ms request target, and the prototype does not change shared runtime code.
At that checkpoint, the S2 runner, preparation strategy comparison, provider
cache/cost measurements and v0.4.0 latency/recovery acceptance were pending.
The later integration results above supersede its implementation status.

## v0.3.3 existing-session compatibility, 2026-10-12 UTC

The v0.3.3 preview runtime `stock-preview+src.9ca9dd2123d49293` was tested on
official npm Pi 1.1.0, with Pi 1.0.4 only for the other-version case. All
services were synthetic and loopback; no real provider was contacted. The source
fingerprint does not include the package version, so the same runtime ID was
measured before and after the version change to 0.3.3.

| Command | Result |
| --- | --- |
| `node scripts/context-memory-ops.mjs verify` | Exit 0: 163 focused checks (94 resident and 69 preview) and 461 host security checks. The resident fingerprint is unchanged. |
| `node scripts/context-memory-preview-build.mjs` | Exit 0: five package files, no host runtime. The bundle adds one preview source file (`notices.ts`); `dist/extension.js` grows from 87 KB to 108 KB. |
| `node scripts/context-memory-preview-acceptance.mjs` | Exit 0: 27 of 27, run from a temporary copy outside any Node project. The new case checks that `/compaction-doctor` and `/compaction-status` send no request and write no marker; removal uses the repository source without a ref. |
| `node scripts/context-memory-preview-scenarios.mjs` with both official installations | Exit 0: 125 passed, 2 known gaps, no failures, no unexpectedly passing gaps, no skips; all 18 control checks behaved as stock Pi. |
| `node --test scripts/context-memory-preview-release-checks.test.mjs` | Exit 0: 7 of 7, including three checks that release notes install the fixed package tag alone and never put two Pi commands, or the fixed tag and the moving branch, in one copyable block. |
| `node scripts/context-memory-ops.mjs eval --full` | Exit 0: 89 of 89 offline evaluator tests; the frozen-input gate did not trigger. |

`node scripts/context-memory-ops.mjs preview`, including the local `--prepare`
step that builds release archives and notes without publishing, exited 0 on the
committed source.

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

The new marker code was checked in both directions on official Pi 1.1.0. A
`CONTEXT_PREVIEW_COMPACT_REQUIRED` marker written by v0.3.3 and opened with the
v0.3.2 package kept requests blocked (v0.3.2 reads it as invalid), stayed on
disk, and was cleared by an explicit `/compact` that wrote a checked
checkpoint, after which requests were sent. A `CONTEXT_PREVIEW_UNSUPPORTED`
marker written by v0.3.2 for the same threshold event and opened with v0.3.3
showed one notice asking for `/compact` and recovered the same way.

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
