---
branch: codex/dsh-opencode-adapter-preview
pr: 99
head: 7bbd89cb60da4a8af9b04eca244871a283481829
written: 2026-10-26, Codex cloud
---

# Handoff: DSH and OpenCode retrieval previews

## Goal and done-when

Implement the accepted lightweight adaptation design and open a new PR, with
this handoff as requested. The bounded implementation is in draft PR #99.
Before review completion, obtain a green full gate, review the public-host
boundaries, and remove this handoff. Do not merge or release without instruction.

## State

Evidence is for `7bbd89c`; full commands and stock-host parameters are in PR #99.

- [verified] `node scripts/context-memory-ops.mjs verify`: exit 1. Build, lint,
  types, core 147 + isolated 147 and adapter 16 tests pass; resident tests have
  516 passes / 57 failures, primarily `CONTEXT_LOCK_IDENTITY`.
- [verified] At clean base `3932a11`, the two resident test files named in the
  PR's baseline command give 39 passes / 57 failures, exit 1 after model-data setup.
- [inferred] The resident failures are environmental, based on the unchanged
  resident source, matching failure counts and unavailable process-start identity.
  This is not a green gate or permission to bypass the lease check.
- [verified] `node scripts/security-regression-check.mjs`: exit 0 (461 tests).
  `npm audit --json`: exit 0, zero advisories; existing lockfile versions unchanged.
- [verified] `context-memory-preview-build.mjs` and stock-Pi acceptance commands
  in PR #99: exit 0; Pi 1.4.0/1.3.0/1.2.0/1.1.0 each 28 assertions; cross-version
  acceptance 34 assertions. Resident fingerprint and checkpoint format unchanged.
- [verified] `context-memory-opencode-acceptance.mjs` with the PR's arguments:
  exit 0, official 1.19.4 on Linux x64; four assertions and 10 loopback synthetic
  provider calls. Two compactions, cold restart, native-ID retrieval, cursor
  continuation and plugin removal; host and candidate bytes unchanged.
- [not run] Full `ci`/frozen evaluation, live providers, interactive DSH CLI, other
  OpenCode versions/platforms. Neither adapter is Checked/Gated.

## Decisions

- Ship retrieval only for both hosts. Reject a DSH writer until public required
  external records survive reopen/removal: rc.3's installed validator rejects
  `slice/checkpoint`, and `appendPluginRecord` excludes external plugins.
  No private catalog mutation, summary-embedded checkpoint or partial transaction.
- Use DSH native seqs and OpenCode native part IDs, opaque native payloads in
  hashes, current unseeded/non-forked session only. Reject invented IDs, parent
  grants and a second database. Each query reads full history; O(history) cost
  is accepted for this preview. See the guide's Evidence and boundaries.
- Keep core executable behavior and Pi hashes unchanged. The structural view
  contract is clarified in comments/spec only; cursor identity remains `hashEntries`.
- Pin DSH rc.3 and OpenCode 1.19.4. Use Zod 4.6.7 directly for OpenCode's public
  tool object; SDK is development-only. Reject the unused full plugin/V2 graph.
  Two root DSH development pins make npm apply the Zod override across workspace
  peers; do not remove them without checking a clean install and audit.

## Read first

1. `AGENTS.md` and `docs/context-memory/handoff-protocol.md`.
2. `docs/context-memory/host-adapters.md` (scope, loading, acceptance, DSH gate).
3. PR #99's diff and validation table; the design document only for a disputed decision.

## Settled

Public-contract evidence and writing prerequisites are in the design and guide.
Keep this PR at retrieval; reconsider the documented gate before adding writing.

## Next steps

1. After the protocol's branch/head check, run `node scripts/context-memory-ops.mjs verify`.
2. Inspect PR #99 CI. If the lock failure recurs, reproduce the PR's baseline;
   retain the limitation rather than weakening safety.
3. Review the two adapters against their pinned public APIs. Once the gate and
   review are satisfied, delete `HANDOFF.md` and carry this check into the PR.

## Previous handoff check

- Missing: none
- Repeated: none
- Wrong: none
- Unused: none
