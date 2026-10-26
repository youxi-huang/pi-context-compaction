---
branch: codex/v072-source-migration-regressions
pr: 98
head: 56b39dff3107749dd20062a8409becae21127d6d
written: 2026-10-25, Codex cloud
---

# Handoff: v0.7.2 source-migration test review

## Goal and done-when

Review and accept the focused test change in PR #98 for the maintainer, using Claude Code cloud.
The test patch is ready when its assertions and isolation have been reviewed, the focused tests
and full verification pass in a capable environment, and results are recorded against the tested
commit. If an environment limitation persists, document it and leave the PR draft.
Actual repository rename/publication and post-rename release acceptance remain separate work.

## State

- [verified] Work tree at `56b39dff3107749dd20062a8409becae21127d6d`: its Git tree exactly matches the tested patch; `git write-tree` returned `ca0cb523980f805870adeae16e60aaf1ccb34ef4`, exit 0.
- [verified] Commands, outcomes, counts, host versions and the before/after full-verification limitation are in [PR #98, Validation already completed](https://github.com/youxi-huang/pi-context-compaction/pull/98). All concern this work tree.
- [not run] Cloud verification of the committed branch and its CI result.
- [not run] Live GitHub redirect, real installed-release source replacement and dual-loaded extension behaviour; see the test guide's Evidence boundaries.
- [inferred] The resident-suite failures depend on this execution environment, based on identical baseline and candidate failure groups. Confirm independently; do not dismiss new failures under that label.

## Decisions

- Keep this a test/verification/documentation PR. No upstream package-manager dedupe patch:
  official-host behaviour cannot be changed by a repository rename, and is what these tests observe.
- Use real package/settings operations over local Git and the real candidate recovery guards;
  do not mock the identity/dedupe algorithm. The synthetic discovery package and session surface
  are deliberately labelled, because they do not establish actual extension-loading behaviour.
- Keep official API runs, existing bundled-extension acceptance and live GitHub acceptance as
  separate evidence. Passing local aliases was rejected as proof of a working GitHub redirect.
- Preserve all settled package names, commands and persistence formats; see the test guide.
  This branch does not authorise repository renaming, release tags, publishing or merging.

## Read first

1. `AGENTS.md` and `docs/context-memory/handoff-protocol.md`.
2. `docs/context-memory/operations.md`: entry points, check scope and the two deliberate gates.
3. `docs/context-memory/source-migration-regressions.md`: coverage, commands and evidence limits.
4. The work-commit diff; focus on the two new migration scripts and their check entry point.
5. `docs/context-memory/extension-preview.md`, Acceptance section, only when reproducing official-host acceptance.

## Settled

The rename scope is recorded in merged PR #95 and the roadmap's 0.7.2 entry.
Do not reopen the naming decision or turn this PR into another rename plan.

## Next steps

1. Fetch this branch and compare it with `head` above under the handoff protocol. Only handoff-only
   commits should follow it; inspect any other changes before continuing.
2. First executable verification: `node scripts/context-memory-ops.mjs verify`.
   It installs/builds as needed. Then run
   `node --test scripts/context-memory-preview-source-migration.test.mjs scripts/context-memory-preview-stock-install.test.mjs`.
3. Review that network denial survives npm children and the temporary Pi update flag change;
   Git remains file-only. Check that fresh on-disk checkpoint validation, pending/failed state,
   tampering, ref handling, both removal directions and both scopes are actually asserted.
4. Reproduce the four supported official-host API runs using the test guide. Build the preview
   and run the existing official-host acceptance separately using the preview guide. Do not run
   `npm test`, the full upstream suite or a real provider. If full verification cannot finish,
   run the remaining focused checks separately and report the incomplete gate.
5. Fix defects within this test/documentation scope on this branch, adding commits only.
   Re-run the affected checks. Do not weaken lock guards, source hashes, assertions or frozen pins.
6. Report the tested SHA, commands, exit codes and remaining release checks in the PR description.
   When ready for review, remove `HANDOFF.md` in the final commit and add the Previous handoff check
   there. Do not merge or publish; the maintainer will decide.

## Previous handoff check

- Missing: none; this is the first handoff for this branch.
- Repeated: none.
- Wrong: none.
- Unused: none.
