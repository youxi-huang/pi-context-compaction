---
branch: claude/peaceful-planck-ziod99
pr: 72
head: 984885af24e5d4e37bc84cd7bc95c6ec80693ab9
written: 2026-10-18 PDT, Codex, cloud
---

# Handoff: review the preview cost measurements and warming stop

## Goal and done-when

Review Z1 and the Z2 stop report for redundancy, as the previous handoff requested. Keep #72 in draft until that review is complete. Before it becomes ready for review, record the final handoff check in its description and delete `HANDOFF.md` in the last commit, per the protocol.

## State

- [verified] Z1's driver exited 0 at `a42f6b7`; its commands, measurements, missing provider counts and proposals are in [validation.md, Z1](docs/context-memory/validation.md#z1-preview-request-and-checkpoint-cost-official-pi-130-2026-10-18-pdt), committed in `5c298e6`. The drivers are saved in #72's description.
- [verified] `node "$driver_dir/z2-driver.mjs" "$PWD"` exited 0 at `5c298e6`: nine cases reproduce the idle-mode stop or confirm its controls on all three hosts. [The stop report](docs/context-memory/cost-plan.md#z2-stop-a-refresh-already-in-flight-survives-settlement) and the Status table are committed in `984885a`. The official-source audit exited 0 at `984885a`; its driver is also in #72.
- [verified] `node scripts/context-memory-ops.mjs ci` at clean `984885a`: exit 0; 20/20 steps. Acceptance 32/32, 28/28, 28/28 on Pi 1.3.0/1.2.0/1.1.0, 148 strict scenarios, 31 release checks, local package preparation and 103 full offline evaluation tests passed. Neither deliberate gate was reached.
- [verified] `git diff --exit-code a42f6b7..984885a -- packages scripts eval` and `git diff --exit-code -- packages/coding-agent/src/extensions/context-memory/build.ts`: exits 0 at `984885a`; the work changes documents only and neither deliberate gate was reached.
- [not run] New real-provider requests, provider acceptance of undeclared historical calls, and Z2's probes after its first stop condition; see the two reports for scope.

## Decisions

- Z1's proposals wait for the maintainer; [the validation entry](docs/context-memory/validation.md#z1-preview-request-and-checkpoint-cost-official-pi-130-2026-10-18-pdt) gives their savings, tradeoffs and the recommendation to keep registration until those are decided.
- Z2 stops without a runtime change. The reason, the streaming control, the rejected scope expansion and the omitted later probes are recorded in [the stop report](docs/context-memory/cost-plan.md#z2-stop-a-refresh-already-in-flight-survives-settlement). Do not turn that control into an implementation in this review.
- Package/source commit binding stays enforced. The first preview run's prepare failure and the successful clean rerun are recorded in #72's Evidence section; no check was weakened.

## Read first

1. [cost-plan.md](docs/context-memory/cost-plan.md): Status, Z2 stop, and Not accepted.
2. [validation.md, Z1](docs/context-memory/validation.md#z1-preview-request-and-checkpoint-cost-official-pi-130-2026-10-18-pdt), 89 lines.
3. [PR #72](https://github.com/youxi-huang/pi-context-compaction/pull/72): Evidence, Why Z2 stops, and the temporary drivers when checking methodology.

## Settled

- The external review's other proposals remain [settled](docs/context-memory/cost-plan.md#settled); arm B keeps its path until 0.8.0.
- Z1 cannot recover an exact voluntary-note total from the published provider record. Its four refusals and qualitative frequency are all that record supports.
- Runtime, host, schema and warming changes are outside this review; this batch measured or stopped as specified.

## Next steps

1. `git diff 86cb9c6..984885a -- docs/context-memory/cost-plan.md docs/context-memory/validation.md` starts the review after the protocol's branch/history check. Compare it with the plan's Not accepted list.
2. Check the Z1 byte/token definitions, historical-evidence limits and proposal costs; check that Z2's report distinguishes the temporary in-memory rule from shipped behavior. The full offline reproductions are in #72, with no dependency on this container's temporary files.
3. Remove redundancy if needed, update the PR description and final handoff check, then follow the protocol's Finishing section. Push only added commits to this branch.

## Previous handoff check

- Missing: exact B-off `context_note` call and accepted-note totals are absent from the linked provider record; only "most turns" and four refusals are recorded.
- Repeated: none.
- Wrong: none; Z2's safety hypothesis failed its prescribed precondition, not a verified handoff claim.
- Unused: none.
