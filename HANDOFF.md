---
branch: claude/great-ritchie-w9ftfu
pr: 84
head: e936a38
written: 2026-10-22, Claude (cloud)
---

# Handoff: WP3 conformance-vector design

## Goal and done-when

The vectors half of WP3 in [the v0.7.0 plan](docs/context-memory/v0.7.0-plan.md#wp3-conformance-vectors-and-the-host-neutral-fixtures):
a conformance vector set under `packages/compaction-core/conformance/`, versioned
`0.7-conformance.1`, pinned by a SHA-256 manifest in the style of
`eval/preview/fixtures/manifest.json`; a vector runner as a core vitest test; and the
RFC 8785 (JCS) canonicalization the dual-serialization vector needs, implemented pure
in the core (`node:` builtins only — the import gate rejects anything else). Done when
every vector gives its expected outcome through the core validator path and `verify`
passes. NOT yours: the fixture converter (in progress in parallel) and the Pi-adapter
vector path; they land separately.

## State

- [verified] `node scripts/context-memory-ops.mjs verify` all eight steps ok, exit 0, at e936a38; CI green on PR #84.
- [inferred] WP2 lifts 4–5 land on this branch in parallel: they move module paths, never validation behavior (rule K2, enforced by the equivalence gate). The validation modules you need are in the core since lift 3 and stable.
- [not run] nothing else.

## Decisions

- H1–H7 taken as the plan proposes (maintainer, 2026-10-22); the spec's status paragraph records the review.
- The closed set is `PROJECT_CODES` as it stands. `CONTEXT_PREVIEW_*`/`CONTEXT_PREPARATION_*` are adapter-local and never appear in vectors; `CONTEXT_SOURCE_PREFIX` is an internal invariant, not a refusal.
- Outcomes match error classes, never message text; all content invented; no session logs, credentials or local paths (K12).
- **Push to your own branch** `codex/wp3-conformance-vectors`, created from this one, and reference PR #84. Do not push to `claude/great-ritchie-w9ftfu`: the lifts land here in parallel and the pushes would race. Rejected: working on this branch directly, for that reason.
- Redundancy is a defect, not coverage: one vector targets one pipeline stage, the record set per vector is minimal, and no class gets duplicate vectors beyond deliberate boundary pairs.

## Read first

1. `packages/compaction-core/spec/specification.md` — the record model, validation and the commit gate, the source hash, the guarantee table. The binding statement of expected classes.
2. The plan's WP3 section (the minimum vector list) and decisions H2, H3, K12.
3. The implemented pipeline the vectors must agree with, all under `packages/compaction-core/src/`: `notes.ts` (`validateNoteContent`, `validateNote` — validation runs per fact, sources scope → quote → supersedes scope interleaved; derive each expected class from this order, not from the spec's stage listing alone), `note-envelope.ts`, `schema-diagnostics.ts`, `sources-repair.ts`, `quote-repair.ts`, `work-notes.ts`, `config.ts` (`selectNoteBudget` tiers, `storedNoteLimit`), `events.ts` (`PROJECT_CODES`), `records.ts`, `identity.ts` (`hashEntries`).

## Settled

- Vector home and version: `conformance/` in the core package, `0.7-conformance.1`, SHA-256 manifest (H3).
- Serializations for the changed-content vector: Pi's `hashEntries` (core `identity.ts`) and H2's canonical form — RFC 8785 JCS of each record's normalized form, framed per record with the same newline byte `hashEntries` uses, SHA-256, hex.
- Record shapes: the spec's record model, concretely `packages/compaction-core/src/records.ts`. Use its exact field names; a parallel task is settling the fixture emitter on the same model, and field-name agreement is reconciled on the orchestrator's side afterward.

## Next steps

1. `git fetch origin claude/great-ritchie-w9ftfu && git checkout -b codex/wp3-conformance-vectors origin/claude/great-ritchie-w9ftfu`
2. Read the list above; write the vector file format (records, candidate note, expected outcome/class) and manifest layout as `packages/compaction-core/conformance/README.md`, short.
3. Build the set covering at least the plan's WP3 list: a valid note; facts without sources; scope misses, missing and unreadable separately, including in `supersedes`; the quotation classes `elsewhere`, `format`, `absent`; budget overflow at the tier boundaries; both answer envelopes and their near misses; a repair that drops what it may not (`CONTEXT_NOTE_REPAIR_LOSS`); an unpaired tool call (`assertToolPairs` — in the core after lift 4, in `preview/controller.ts` before it; take whichever the tree has); a continuation left out; cited content changed under the same record ID, caught under both serializations.
4. Implement the JCS canonicalization and the runner; every vector green through the core validator. The isolation check copies only `package.json`, `tsconfig.json`, `src`, `test` into its temp directory (`scripts/context-memory-core-check.mjs`): add `conformance` to that one copy list so the runner also passes in isolation — the only edit outside the core package you may make.
5. `node scripts/context-memory-ops.mjs verify` before pushing; all eight steps green; no change to `CHANGELOG.md`, the five shared extension files, `eval/`, or the resident fingerprint.

## Previous handoff check

- Missing: none — first handoff on this branch.
- Repeated: none.
- Wrong: none.
- Unused: none.
