---
branch: claude/blissful-archimedes-v1glwi
pr: see the kickoff line
head: 5095e02
written: 2026-10-18, Claude Code, cloud
---

# Handoff: preview experience pass

## Goal and done-when

Make the independent preview quiet in ordinary work and specific when it stops, without changing what it checks, blocks or stores. The plan is [docs/context-memory/ux-plan.md](docs/context-memory/ux-plan.md). Done when U1 and U2 are merged into this branch with `verify` and `preview` green, and the U3 entry is in `validation.md`.

## How this handoff runs

One Codex session per package, in parallel. The kickoff line names the package.

- Start your own branch from this one, do the named package only, and open the PR against this branch, not `main`.
- Leave `HANDOFF.md` in place: it is deleted when this branch's own PR is finished. Your `Previous handoff check` goes in your PR description.
- Never push to or rewrite this branch.
- The integrating review removes everything the plan's [Not accepted](docs/context-memory/ux-plan.md#not-accepted) list names. Leaving it out saves a round.

## State

- [verified] `node scripts/context-memory-ops.mjs verify`: ok, exit 0, at e020cda.
- [verified] `node scripts/context-memory-ops.mjs preview`: ok, exit 0, at e020cda. Acceptance on official Pi 1.3.0, 1.2.0 and 1.1.0, the Pi 1.0.4 refusal and the strict scenarios.
- [verified] `setStatus(key: string, text: string | undefined)` is declared in `dist/core/extensions/types.d.ts` of the three official hosts that `preview` installs under `.artifacts/`. On 1.3.0, `dist/modes/interactive/components/footer.js` joins extension statuses on one line, sorted by key.
- [verified] When the extension cancels a manual `/compact`, stock Pi 1.3.0 also shows `Compaction cancelled` (`cancelledByExtension` in `dist/core/agent-session.js`).
- [inferred] Changes under `preview/` leave the resident fingerprint alone, based on `scripts/stamp-context-memory.mjs` hashing only top-level `context-memory/*.ts`.
- [inferred] Some `PROJECT_CODES` can reach the fallback advice, based on 25 codes having no entry in `notices.ts`. U2 traces which.
- [not run] Pi's interactive TUI on a real terminal; any provider run.

## Decisions

D1 to D6 are in the plan with what each rejected. Exceptions to the [handoff protocol](docs/context-memory/handoff-protocol.md): sessions run in parallel, their PRs target this branch, and `HANDOFF.md` stays until integration.

## Read first

1. [AGENTS.md](AGENTS.md).
2. In the plan: your package, Not accepted and Verification.
3. `preview/notices.ts` and `preview/extension.ts`. In `preview/controller.ts`: `sessionStart`, `standAside`, `fail`, `reportBlocked`, `compact`, `committed`, `recover`, `compactionFailed`.

## Settled

- Notice prefix `Source-linked compaction` (D1) and the U1 footer texts. A package does not reopen them.
- What stays unchanged: D5 in the plan.
- Versions, fingerprints, tags and releases belong to the maintainer ([AGENTS.md](AGENTS.md)).

## Next steps

1. U1: implement [Footer state](docs/context-memory/ux-plan.md#u1-footer-state), run Verification, open the PR.
2. U2: implement [One voice](docs/context-memory/ux-plan.md#u2-one-voice), with the before/after table in the PR description.
3. U3: answer [Where the time goes](docs/context-memory/ux-plan.md#u3-where-the-time-goes). The PR holds the `validation.md` entry and the `observe()` rows only.
4. Then Claude Code reviews each PR against Not accepted, merges it into this branch, updates the plan's Status, deletes `HANDOFF.md` and readies this branch's PR.

## Previous handoff check

- Missing: none, first handoff on this topic
- Repeated: none
- Wrong: none
- Unused: none
