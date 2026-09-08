# Architecture

The original session JSONL is the history store. A checkpoint contains a structured note plus source identifiers and a branch snapshot. Original records remain available through a bounded history API.

## Runtime modules

| Module | Responsibility |
| --- | --- |
| `config.ts` | Process-latched enable flag, writer selection and capacity budgets. |
| `loader.ts`, `extension.ts`, `policy.ts` | Resident loading, tools, ownership, handler ordering and competing-compactor rejection. |
| `controller.ts` | Freeze source, invoke writer, validate candidate and block requests after failure. |
| `writer.ts`, `notes.ts` | Source chunks, structured notes, quotation/citation checks and accumulated usage. |
| `history.ts`, `grant-file.ts` | Snapshots, bounded search/read, child identity and revocation. |
| `lease.ts`, `storage.ts` | Process identity, writer ownership, atomic first publication and append rollback. |
| `identity.ts`, `build.ts`, `index.ts` | Format identity, source fingerprint and public integration surface. |

## Host changes

The SDK wraps resource loaders so ordinary filtering cannot remove the resident. Runtime construction checks ownership and tools. The extension runner propagates request-blocking failures from the resident instead of swallowing them. For `session_before_compact` it runs other extensions first and the resident last; a non-resident handler may observe the event and return `undefined`, but any returned compaction or cancellation is rejected before the writer runs.

`SessionManager` calls storage before publishing candidate entries to its in-memory tree. This includes first flush and subsequent writes. Session opening, branching and forking acquire a destination lease before exposing writable state. Extension events alone run too late to enforce these boundaries.

The controller returns a compaction candidate to Pi's existing commit path. It does not append checkpoints or replace agent messages itself. Storage checks the source snapshot again at commit. Cancellation, changed sources and disk failures leave the candidate uncommitted. Failed compaction blocks the next provider request until explicit retry or new input.

## Notes and retrieval

The writer receives the previous note, new original records and bounded excerpts of referenced originals. Increment notes are unverified candidates. Every quote must appear verbatim in a cited record; every source must be on the selected branch. These checks establish reference consistency, not semantic completeness.

The compaction threshold is `min(model cap, 0.8 × context window, context window − output reserve)`. Caps are 400,000 for GPT and 200,000 for Gemini; other families have no extra cap. Final request checks include serialized payload size. Estimates are conservative approximations, not billing measurements.

`context_history` searches or reads the current ancestor chain. Parent hosts can grant a particular child access to a frozen source range. Revocation stops further reads. Grants exclude later parent messages, sibling branches and recursively inherited authority. Cross-process manifests require parent identity and source checks.

## Persistence limits

The lease uses an atomic directory adjacent to the session. Stale ownership is reclaimed only when process identity establishes that the owner is gone. Unknown ownership requires inspection. Append failure attempts to restore the original length; failed rollback poisons storage and preserves a recovery marker.

External-write checks compare device, inode, length and mtime. Metadata-only ctime changes are not treated as content writes. This is a cooperative consistency guard, not protection against a hostile process that rewrites files and restores timestamps. Atomic publication and file fsync do not establish verified recovery from every power-loss or filesystem failure.

Disabled mode returns to Pi's default compactor after restart. Summaries remain readable and custom entries remain archived. Storage and opaque-history checks still apply. Windows persistence and network-filesystem locking are unsupported.
