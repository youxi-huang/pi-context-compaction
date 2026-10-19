---
branch: claude/peaceful-planck-ziod99
pr: 72
head: 51d9529
written: 2026-10-19, Claude Code, cloud
---

# Handoff: preview cost batch, Z1 and Z2

## Goal and done-when

Carry out Z1, then Z2, of [cost-plan.md](docs/context-memory/cost-plan.md) for Codex. Done when Z1's `validation.md` entry is committed, Z2 is either implemented with its evidence and CI green or stopped at a precondition with the report, the plan's Status table says which, and a new `HANDOFF.md` for the review session is pushed. A Claude Code session then reviews the diff for redundancy before the PR leaves draft.

## State

- [verified] Every line the plan cites matches the source: `sed -n 110p` and `sed -n 158p` of `preview/extension.ts`, `sed -n 183p` and `sed -n 293p` of `scripts/context-memory-preview-acceptance.mjs`, `grep -n` in `packages/ai/scripts/generate-models.ts` (lines 982 and 992), each exit 0, at `86cb9c6`. `51d9529` adds only the plan.
- [verified] No open PRs before this one: GitHub pull request list, open state, empty, 2026-10-19.
- [inferred] Official Pi 1.3.0 and 1.2.0 warm the cache as the 1.1.0 snapshot does, based on the snapshot's `core/cache-warmer.ts` and the acceptance warming case, which CI runs on every listed host (`scripts/context-memory-preview-acceptance.mjs:246`).
- [inferred] In `streaming` mode no refresh can land inside a compaction; in `idle` mode one can. Based on the snapshot's `core/sdk.ts:379-440` and `core/agent-session.ts:1083-1084`. Z2 must confirm this on each host.
- [not run] `ops doctor`, `ops verify`, the preview build, acceptance, scenarios and tests. This session read code and wrote documents only.

## Decisions

- Two packages, Z1 then Z2, each its own commit. Rejected: the external review's other proposals, for the reasons in [Settled](docs/context-memory/cost-plan.md#settled).
- `context_note` stays registered in every session for now. Z1 measures it and proposes; the maintainer decides. Rejected: gating it on arm B in this batch, because it removes a workflow the [preview guide](docs/context-memory/extension-preview.md#supported-workflow) documents, changes the tool set the evaluation compares, and how providers treat earlier calls to a tool no longer declared is unverified.
- Z2 lets Pi decide only while an agent run is active, with no compaction active or staged and no failure held. Rejected: Pi's decision in every ready session, because an `idle` refresh can be in flight when `/compact` begins and its entry would fail the compaction with `CONTEXT_SOURCE_CHANGED`. Rejected: accepting `cache_warm` entries inside the source check, because that changes a trust-boundary check. Rejected: a warming setting, because the plan adds none. Rejected: reading the phase from `continuationProbability === 1`, because that couples the rule to a Pi constant; track runs from Pi's events instead.
- Z2's stop conditions are the plan's, unchanged. A stop is a result, not a failure: report it and leave runtime code as it is.
- No provider run and no credentials. Every number is offline and scripted.
- Keep the diff to what each package names. The review removes anything on the plan's [Not accepted](docs/context-memory/cost-plan.md#not-accepted) list.

## Read first

1. [cost-plan.md](docs/context-memory/cost-plan.md), whole.
2. [ux-plan.md](docs/context-memory/ux-plan.md#not-accepted), Not accepted and Verification only.
3. [operations.md](docs/context-memory/operations.md#evidence), Evidence and Two deliberate gates.
4. The [U3 entry](docs/context-memory/validation.md#preview-reopen-and-compaction-overhead-on-official-pi-130-2026-10-18-utc) in `validation.md`, as the model for Z1's method and length.
5. `scripts/context-memory-preview-acceptance.mjs:115-300`, the warming case and its fixture.
6. In the snapshot: `packages/coding-agent/src/core/cache-warmer.ts`, `core/sdk.ts:379-440`, `core/agent-session.ts:1083`. Then the same code in each official host's `dist`.

## Settled

- The external review's proposals: [cost-plan.md#settled](docs/context-memory/cost-plan.md#settled).
- Arm B keeps its path until 0.8.0: [roadmap](docs/context-memory/roadmap.md#planned-minor-releases), maintainer decision of 2026-10-17.
- Version strings, build identities, tags and the resident runtime are out of scope: [AGENTS.md](AGENTS.md).

## Next steps

1. `git fetch origin claude/peaceful-planck-ziod99 && git checkout -B claude/peaceful-planck-ziod99 origin/claude/peaceful-planck-ziod99`. If you can push only to your own branch, start it here, open a draft PR against `main` (CI runs only there) and link #72.
2. `node scripts/context-memory-ops.mjs doctor`, then `node scripts/context-memory-ops.mjs verify`. Record both with exit codes.
3. Z1: `node scripts/context-memory-preview-build.mjs`, then measure items 1 to 4 on official Pi 1.3.0 with the scenario runner's isolation, as U3 did. Commit the `validation.md` entry as `docs: record what each preview request carries`.
4. Z2: confirm the three snapshot claims and the stop conditions on 1.3.0, 1.2.0 and 1.1.0 first. Implement only if all hold, then run the plan's Verification. Commit as `fix: let Pi warm the cache while a guarded turn runs`, or record the stop in the plan's Status table.
5. Update the Status table, write the next `HANDOFF.md` for the review session per the [protocol](docs/context-memory/handoff-protocol.md), push, and leave the PR in draft.

## Previous handoff check

- Missing: none
- Repeated: none
- Wrong: none
- Unused: none
