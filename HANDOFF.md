---
branch: codex/context-pressure-profile
pr: 104
head: 013d3a19922cc1b44f8dec68a86a7b5dd9aaa213
written: 2026-10-28 UTC, Codex cloud
---

# Handoff: review and simplify capacity profiles

## Goal and done-when

The user asked for deep Pi/OpenCode/DSH simulations before a PR, then Claude's
independent correctness review and removal of redundancy. Review this existing
patch, fix findings, simplify it, rerun affected checks and push to this branch.
Keep the PR draft until review is complete. Do not merge or release.

## State

All local evidence below binds to the exact Git tree of `head`; publishing
through the GitHub connector preserved that tree byte for byte.

- [verified] `context-memory-preview-acceptance.mjs` on official Pi 1.1.0–1.4.0: 33 checks per version, exit 0 at `head`, including three native pressure cycles, prepared reuse, writer failure and cold restart. Exact flags: validation record below.
- [verified] `context-memory-opencode-acceptance.mjs --pressure-mode declared` and `--pressure-mode missing-input`: both exit 0 at `head`, with actual native lines 150k and 168k, three cycles, failed summary/retry and cold restart.
- [verified] `context-memory-dsh-acceptance.mjs`: exit 0 at `head`; native loop/meter/storage, three cycles, 320 kB tool output, cold restart, writer failure, smaller/missing limits.
- [verified] `node scripts/security-regression-check.mjs`: exit 0 at `head`.
- [verified] `node scripts/context-memory-ops.mjs verify`: exit 1 at `head`; 57 resident `CONTEXT_LOCK_IDENTITY` failures also reproduced on clean `504899c`. Other checks and all preview tests pass. Do not bypass identity checks. Check current PR CI for the normal-environment result.
- [not run] Real-provider 200k stress/quality/latency/cost comparisons, terminal UI and OpenCode V2.

## Decisions

The formulas, constants, native differences and research sources are settled
in `docs/context-memory/context-pressure.md`. Keep the change opt-in: no
settings writes, automatic paid preparation, new scheduler or default-retention
change. Rejected a fixed 200k branch and full OpenCode/DSH writer takeover:
neither is necessary for this correction, and their persistence gates remain.
Preparation reuses the existing once-per-checkpoint journal and validation;
it never delays safety checks. Rejected a new cooldown for that reason.
Native DSH continues after summary failure; this fixture verifies that limit,
not a cross-host Slice fail-closed guarantee. No frozen-runtime changes.

## Read first

1. `AGENTS.md` and `docs/context-memory/handoff-protocol.md`.
2. PR #104 diff; `docs/context-memory/context-pressure.md`.
3. `docs/context-memory/validation.md`, only “Capacity profile: official-host pressure simulations”.
4. `docs/context-memory/host-adapters.md`, only native contracts and writing gates.

## Next steps

1. After the protocol's branch/head check, run `node --test scripts/context-memory-pressure-profile.test.mjs`, then inspect `git diff origin/main...HEAD -- packages/compaction-core/src/context-pressure.ts packages/coding-agent/src/extensions/context-memory/preview/controller.ts`.
2. Review formulas against host semantics, especially absent input limits, output reservation, existing Pi model-specific budget caps, model switches and whole-turn retention. Keep preparation hints distinct from request guards.
3. Look for removable duplication between the 309-line unit fixture and new official-Pi cases, repeated fixture construction in acceptance scripts, and repeated explanations across docs. Prefer fewer concepts; do not merge host-specific failure policies into a fictional shared guarantee.
4. Preserve source hashes/quotes, disk confirmation, failed-request blocking, call bounds, official-host provenance and isolation. Retain tests that protect distinct boundaries; do not add a second history index or widen the adapter scope.
5. Run the affected official-host commands from the capacity guide and the repository gates. Address any CI failure; never change the frozen pin or build fingerprint to make it green. Add commits only and push this branch.
6. When review is complete, remove `HANDOFF.md` in the last commit and move the final Previous handoff check and open limitations into the PR description, per protocol.

## Previous handoff check

- Missing: none; no earlier branch handoff was consumed.
- Repeated: none.
- Wrong: none.
- Unused: none.
