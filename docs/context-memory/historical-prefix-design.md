# Historical prefix with retained originals: proposed contract

Superseded on 2026-10-13 by decision D16 in the [plan](v0.4.0-plan.md). The
preview now commits a prepared note for the prefix it covers and keeps every
later original verbatim, without the authority contract this proposal required:
newer messages keep their own words and position after the note, as in an
ordinary conversation. The implemented path is narrower than this proposal. It
uses the prepared candidate's frozen prefix, cuts only at a turn start that drops
nothing uncovered and follows the previous checkpoint, and commits only when the
context shrinks and fits within 80% of the threshold. The text below is the
original proposal.

Status: design for review, not an enabled commit path. This makes the third
submission option identified in the v0.4.0 review concrete without treating
permissive `coveredThrough` validation as a complete persistence or authority
contract. The current runtime still submits full-coverage checkpoints.

## Result and limits

A source-valid prepared note can replace only the history it actually represents.
Later originals stay in Pi's recent context, so manual submission can avoid a
writer call even when preparation no longer describes the whole branch. This
trades context release for a shorter generation boundary. It is a distinct path
from complete-candidate reuse and same-writer reconciliation, and its pauses and
retained input must be reported separately.

An old note may contain an instruction that a newer user ruling revokes. Keeping
the newer original gives the model evidence; it does not prove that the old note
was reconciled. The proposal therefore needs both temporal scoping and the
[instruction-authority contract](archive/instruction-authority-design.md). Until the
consumer can mechanically keep historical model prose out of its authoritative
instruction lane, use the current merge or synchronous path.

This is a proposed refinement of the roadmap's complete/current handover
requirement. It does not silently redefine that requirement. The maintainer must
decide whether to admit historical-prefix evidence as an additional path after
its gates pass, or keep all v0.4.0 submissions current and fully reconciled.

## Four separate identities

| Identity | Meaning | Bound at submission |
| --- | --- | --- |
| Full attempt | The complete selected ancestor branch before Pi appends the checkpoint | Session, leaf, previous checkpoint, ordered full-branch hash |
| Covered prefix | The prepared candidate's frozen cumulative source range and validated output | Covered-through ID, ordered prefix hash, candidate ID plus output hash, base-checkpoint hash and delivered user horizon |
| Released projection | Active context actually omitted by the selected safe cut | Ordered source membership, projected tool/turn boundary, released proxy and current context reduction |
| Retained projection | Every original after the cut that still contributes model context | First-kept ID, ordered retained membership/projection hash and resulting provider input allowance |

All source hashes retain the established exact `JSON.stringify(entry)` plus
newline byte rule. A leaf ID or equal prefix hash alone cannot establish current
authority. Projection hashes must name the conversion rules; they are not aliases
for lifetime JSONL bytes or the full branch hash.

The note may cite only entries inside its frozen prefix, including originals
represented by its base checkpoint. Validate every `sources`, `supersedes` and
quote reference against that boundary. Existing shared validation can resolve
references up to a checkpoint's position, which is too broad for this proposed
path; candidate-specific prefix validation remains mandatory.

## Cut and eligibility algorithm

1. Validate the current branch and disk source state, freeze the full submission
   identity, and determine ordinary manual-compaction eligibility. Preparation
   did not enter pending state or reserve a future commit.
2. Classify the candidate as source-valid for its prefix. Verify ancestry, base
   checkpoint, actual writer/prompt/schema identities and source membership.
   A candidate with a changed source or incompatible writer is not eligible.
3. Find the candidate's covered index in the full branch. Enumerate safe cuts no
   later than `coveredIndex + 1`. Safe means the projected turn/tool boundary,
   not merely a raw entry index. Retain the extra covered originals if the cut
   must move earlier to preserve a complete pair or turn. The minimum experiment
   forbids a cut before the previous checkpoint's retained-context boundary;
   otherwise stock Pi can revive originals that are currently inactive. This
   restriction may leave no eligible cut, in which case merge instead.
4. Prove that every active item omitted by the cut is represented by the
   cumulative candidate input. Do not omit the previous note's state, a new
   ruling, a recovery omission or a custom message simply because its raw index
   lies before a convenient cut. Input coverage is structural evidence, not a
   claim that the writer preserved every fact semantically.
5. Construct a synthetic appended checkpoint and compute the actual resulting
   projection with the supported host's `buildSessionProjection`, including its
   `buildContextEntries` behavior. Do not approximate this by filtering today's
   active projection: a backward cut can restore previously inactive records.
   Check actual ordered membership, retry omissions and complete tool pairing
   against the intended temporal/evidence projection. Keep all later originals
   in their original order. Establish current instruction authority
   from the complete branch's host receipts, including later replacement and
   revocation; never obtain current instructions from the frozen note's prose.
6. Recalculate note limits from actual released active content. Require the note
   to fit the submission hard limit, and the resulting note, authority lane,
   retained originals, system state and tools to fit the recovery threshold and
   provider input allowance. Different preparation/submission tiers are not a
   rejection by themselves.
7. Require positive measured context release. Record before/after projected
   input and both released and retained footprint. Replacing a note with a larger
   note plus the entire tail is not automatically useful compression.
8. A new custom `/compact` instruction defaults to generation unless an explicit
   compatibility check proves that the historical-evidence projection satisfies
   it. Never drop the instruction to obtain zero generation.
9. Only then choose this path and enter the normal pending/stage/Pi append/disk
   confirmation gate. If no safe cut fits, use the same-writer merge. If no valid
   handover can be produced, preserve the existing blocking failure contract.

The initial experiment stays at completed text turns and manual submission.
Reusing this path during an unfinished task requires a separate continuation
contract and is outside this proposal.

## Persistence envelope for review

The current attempt has one `leafId` and one full `sourceHash`; current staging
requires the checkpoint's coverage to equal both. Extend the proposed attempt
with a discriminated coverage envelope while retaining its full source identity:

```ts
type ProposedCoverage =
  | { mode: "full"; coveredThrough: string; prefixHash: string }
  | {
      mode: "historical-prefix";
      coveredThrough: string;
      prefixHash: string;
      candidateId: string;
      outputHash: string;
      firstKeptEntryId: string;
      projectionContract: string;
      authorityContract: string;
      retainedProjectionHash: string;
    };
```

This sketch is not a released schema or an instruction to increment the current
version constant. The concrete design must specify bounds and exact parsers for
all fields. The checkpoint binds the full pre-append snapshot, prefix coverage,
safe cut, projection/authority contract identities and the actual rendered
summary. None of these fields is supplied on the model's authority.
The present preparation candidate ID binds its input, not a unique generated
output. Bind the finalized `outputHash` and the store's full staged candidate
digest too; identical preparation inputs with different valid outputs must not
alias a committed artifact.

Use a separately versioned marker and checkpoint/projection envelope so an older
reader explicitly refuses unsupported authority/temporal semantics. Reusing the
old schema number with optional ignored fields is not a rollback proof: current
summary validation uses a prefix match and does not validate a historical scope
envelope. The initial strict experiment should use fresh opted-in sessions.
Legacy sessions retain their declared legacy behavior; there is no silent
migration or rewriting of original checkpoints.

At staging, reread the full source branch and verify both its full hash and the
covered prefix hash. Rebuild the actual synthetic post-append projection, validate
its first-kept membership, complete tools and budget, and bind the
complete candidate bytes. At confirmation, reread the exact appended checkpoint,
its parent, full source branch, covered prefix and retained projection. Check the
same authority receipt replay at the full submission horizon before clearing the
marker. Reopening reconstructs the same temporal projection from originals and
the committed envelope; a preparation ledger is not a second history database.

The authority proposal's enrollment/rollback proof is also a prerequisite here:
changing the checkpoint discriminator can cause an unenrolled legacy preview to
stand aside, and a new marker may be overwritten by an old explicit retry. A new
version alone does not establish refusal. Keep this path inactive until the
supported old readers reject it before the first checkpoint and through their
retry/recovery paths, or the maintainer selects a concrete compatible mechanism.

The following interruptions keep the existing distinction: an unused preparation
is non-blocking and paid work stays accounted; failed staging, append or disk
confirmation blocks requests; an already staged disk claim waits for explicit
recovery. Recovery may confirm the existing exact checkpoint, not regenerate its
note or choose another cut. Update/rollback with an unsupported marker or
checkpoint remains blocked and must not resume with native compaction.

## Required regressions and measurement

| Case | Required outcome |
| --- | --- |
| Candidate covers an early prefix, small later tail | Zero writer calls, positive release, full tail retained and exact disk confirmation |
| Later user revokes an old permission | Historical note stays evidence; full-horizon active receipts exclude the revoked permission; action probe refuses it |
| Later source changes a value or marks work complete | Raw later records survive in order; probes use the newer value and do not repeat completed work |
| Quote or supersedes reference points beyond candidate coverage | Reject the prefix path before staging |
| Safe cut crosses a tool pair or recovery omission | Move the cut earlier only if the complete projection still fits; otherwise merge |
| Cut precedes the previous retained boundary | Decline in the minimum experiment; synthetic post-append projection must expose any revived records and reject unintended membership |
| Tail exceeds recovery or provider allowance | Same-writer merge or synchronous path; no truncation and no additional allowance |
| No measured context release | Decline the prefix path rather than publish ineffective compression |
| New custom focus, changed writer or incompatible instruction contract | Generation or rejection according to explicit compatibility rules |
| Same leaf with changed historical source or retained record | Full disk/hash validation rejects submission or confirmation |
| Stage/append/cancellation/directory-fsync failure | Durable block and existing retry/recovery distinctions remain |
| Restart after staging, before confirmation | Exact staged identity is recoverable; no preparation content is reconstructed from accounting |
| Reopen or rollback with unsupported envelope | Refuse before a provider request; never reinterpret temporal evidence as a current note |
| Receipt-only enrollment or old explicit retry after rollback | Ownership cannot disappear or be overwritten into a legacy handover |

Freeze the experiment before execution. Report path selection, release and
retained footprint, total later task input, pause, all preparation/merge/fallback
usage and authority/action probes alongside a matched full-coverage control.
One prefix reuse is not a natural hit-rate estimate, and lower compression cannot
be pooled into the primary same-cut latency comparison. No live experiment is
authorized by this design.
