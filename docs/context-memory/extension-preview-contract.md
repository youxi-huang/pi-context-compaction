# Stock-Pi extension preview: implementation contract

This is the implementation contract for the v0.3.1 independent-extension
preview. The [installation guide](extension-preview.md) owns public usage and
publication instructions. Resident build fingerprints and the six host
integration files remain unchanged; provider-quality validation is separate.

## Supported first candidate

- Unmodified official Pi 1.1.0, Node.js 22.19 or newer, macOS/Linux.
- Normal CLI/TUI/SDK sessions that actually load this package; fresh persistent
  text sessions and reopening sessions created with this candidate.
- A single Pi process writes a session. Other compactors and extensions changing
  model-visible context are outside the initial verified support matrix.
- Manual compaction at a completed turn, source-linked notes, branch-scoped
  original-history retrieval, and task continuation after reopening.
- The session model is the default writer; an explicitly configured fixed writer
  is allowed. Existing credentials are resolved through the public model registry.
- Native automatic compaction is cancelled explicitly outside supported completed
  turn boundaries. Its supported scheduling is evaluated separately; no host
  settings or source files are rewritten to imitate resident scheduling.
- Background cache warming is paused through the public decision event while
  enabled, because that transport bypasses ordinary request guards.

## Core and commit ownership

Agent A owns `preview/extension.ts`, `preview/controller.ts`,
`preview/writer.ts` and any additional core modules under `preview/` except the
failure-store modules and contracts. It uses public Pi package imports, reuses
the existing note/config/history primitives, and does not edit resident source.
The portable writer may retain the existing algorithm in a separate module with
its host dependency narrowed to public registry methods. It does not import
resident loader, policy, controller or storage mechanics.

Agent B owns `preview/failure-store.ts` and its private persistence helpers. It
implements `PreviewFailureStoreContract` from `preview/contracts.ts`. Agent A
instantiates `PreviewFailureStore(agentDir)` and calls the contract methods.
The store owns pending/blocked operational state; it is not a history database.

An attempt is persisted as pending before the writer starts. After generation,
A rechecks the source snapshot, validates note citations and exact quotations,
and calls `stage` before returning a custom compaction result to Pi. Pi owns
checkpoint append. On `session_compact`, A validates the saved note and B reads
the checkpoint and its source prefix back from the persistent JSONL. Only then
may B remove the marker. A write failure or unreported/interrupted attempt stays
blocked, including after reload, restart or reopening.

`session_before_compact` catches failure, preserves its controlled error code,
persists a blocked marker and returns `{ cancel: true }`, preventing the stock
runner from falling back to native summarization. Request guards catch every
validation/state failure and call `ctx.abort()` as well as reporting the error;
throwing alone does not stop requests on stock Pi. Ordinary new input does not
clear a failure. Explicit manual `/compact` is a retry operation; it clears the
failure only after a newly validated checkpoint is confirmed on disk. A pending
attempt whose commit outcome was not observed also requires explicit recovery.
`/compaction-recover` may confirm an already staged checkpoint only when it is
the current leaf, its note passes validation, and its candidate/source hashes
match the marker and actual disk records. It never clears an unstaged failure.

Config/IO/invalid-marker errors fail closed. Error markers store controlled codes,
IDs and hashes, never model output, transcript text, note text or credentials.
If the first pending marker cannot write any bytes, the failure is sticky in
the current process but cannot be promised across restart after storage is
repaired. Already persisted pending/blocked markers survive later IO failures.
In-memory sessions do not establish persistent recovery guarantees and are
refused by the initial candidate. The extension does not claim resident
disk-before-memory ordering or leases covering writes by nonparticipating Pi.
Deliberately disabling/removing the extension ends its protection; that is an
explicit support boundary, not an automatic recovery operation.

## Independent acceptance and integration

Agent C owns `packages/coding-agent/test/context-memory-preview.test.ts`, matching
synthetic fixtures, and `scripts/context-memory-preview-acceptance.mjs`. It designs
adversarial scenarios independently, tests the actual candidate against a clean
official Pi 1.1.0 installation, and reports failure cases to A/B. It may not edit
A/B implementation files. No agent creates additional agents.

The main agent owns contracts, candidate build/pack scripts, documentation,
changelog, verification wiring and cross-module integration. The candidate has a
minimal package manifest, a public default extension entry and host-provided
dependencies kept external. Installation, configuration, source validation,
history retrieval, reopen, update, remove and compatible rollback are checked
without publishing a package or using real provider credentials.

Acceptance must include malformed notes, wrong quotations, writer unavailability,
changed source snapshots, cancelled compaction, failed writes, failed marker IO,
corrupt markers, reload/restart bypass attempts, unrelated session isolation and
retries. Synthetic/local provider results and any later real-provider results
are recorded separately. Publication follows a reviewed PR, final-commit CI
and the tagged workflow; it does not deploy to a maintainer's global Pi.
