---
branch: claude/peaceful-planck-ziod99
pr: 72
head: 389798d
written: 2026-10-19, Claude Code, cloud
---

# Handoff: `context_note` with arm B only (Z3)

## Goal and done-when

Carry out [Z3](docs/context-memory/cost-plan.md#z3-context_note-with-arm-b-only). Done when Z3 is implemented with its evidence and CI green, or stopped at its condition with the report; the plan's Status row says which; #72's description gains a Z3 section; and a new `HANDOFF.md` for the review session is pushed. Leave #72 in draft.

## State

- [verified] #72 is open, and CI on `9dabad9` passed: `verify`, CodeQL and three analyses, each `success` (GitHub check runs, 2026-10-19).
- [verified] The 1.1.0 snapshot declares `defaultActive` and `setActiveTools`: `grep -n "setActiveTools\|defaultActive" packages/coding-agent/src/core/extensions/types.ts`, exit 0, at `9dabad9` (lines 615-622 and 1750).
- [verified] Scripts use `context_note` only in the scenario case with arm B on, in the check that B off sends no guideline, and in the A/B runner: `grep -n context_note scripts/context-memory-preview-*.mjs`, exit 0, at `9dabad9`.
- [inferred] Official 1.2.0 and 1.3.0 keep both, based on the snapshot being upstream 1.1.0. Not checked.
- [not run] `ops verify`, `ops preview` and the tests. `389798d` adds only the plan.

## Decisions

- With B off, `context_note` is offered only to a branch that already calls it. Chosen by the maintainer on 2026-10-19. Rejected: registering it only with B, because sessions with earlier calls would send calls to a tool no longer declared, and no provider has been tested with that (Z1). Rejected: keeping today's behavior, which costs about 1,209 tokens per request plus the rounds the model spends on notes. Rejected: a real-provider check first, which needs the maintainer's credentials.
- Activation only adds the tool. Rejected: deactivating it at each session start, because that would override the user's or another extension's choice. A tool left active after switching away from a session that needed it costs only its declaration.
- Any assistant call counts, saved or refused. Rejected: saved notes only, because a refused call leaves a call with no saved entry. Rejected: only calls still in the model's context, because that changes the tool set at a commit and adds states to test.
- The `$defs` schema is not part of this batch. The maintainer chose only the first proposal.

## Read first

1. [cost-plan.md](docs/context-memory/cost-plan.md): Z3, Not accepted, Status.
2. `packages/coding-agent/src/extensions/context-memory/preview/extension.ts`: the `context_note` registration and the `session_start` and `session_tree` handlers.
3. #72's description: the Z1 driver to adapt for steps 1 to 4.
4. [ux-plan.md](docs/context-memory/ux-plan.md#verification): Verification.

## Settled

- Z1's measurements and Z2's stop: [cost-plan.md#status](docs/context-memory/cost-plan.md#status), [validation.md, Z1](docs/context-memory/validation.md#z1-preview-request-and-checkpoint-cost-official-pi-130-2026-10-18-pdt).
- Arm B keeps its path until 0.8.0: [roadmap](docs/context-memory/roadmap.md#planned-minor-releases).

## Next steps

1. `git fetch origin claude/peaceful-planck-ziod99 && git checkout -B claude/peaceful-planck-ziod99 origin/claude/peaceful-planck-ziod99`. If you can push only to your own branch, start it here and link #72.
2. `node scripts/context-memory-ops.mjs doctor`, then `node scripts/context-memory-ops.mjs verify`. Record both with exit codes.
3. On official 1.3.0, 1.2.0 and 1.1.0, check that a B-off registration can start inactive and that activation at `session_start` reaches the first request. If either fails, stop and report.
4. Implement Z3 with its regressions, run the plan's Verification, then steps 1 to 4 per host. Commit as `feat: offer context_note only with arm B or an earlier call`.
5. Update the Status row and #72's description, write the next `HANDOFF.md` per the [protocol](docs/context-memory/handoff-protocol.md), and push.

## Previous handoff check

- Missing: none. This session resumed without a handoff; Codex's last one is checked in #72's review comment.
- Repeated: none
- Wrong: none
- Unused: none
