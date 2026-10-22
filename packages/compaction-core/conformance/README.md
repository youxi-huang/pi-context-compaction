# Core conformance vectors

`0.7-conformance.1` implements the vectors half of WP3 from
[the specification](../spec/specification.md). Every record and sentence is
invented. These vectors exercise the core directly; the Pi converter and adapter
path are a separate work package tracked in PR #84.

`manifest.json` maps each data filename to SHA-256 of its exact UTF-8 file bytes,
including the final newline, like the preview fixture manifest. The test rejects
missing, extra or changed JSON files. Change the version when changing a published
vector contract; do not regenerate hashes merely to clear a failure.

Each object in `vectors.json` has a unique `id`, `stage`, ordered `records` using
the exact fields of `src/records.ts` (`type`, not `kind`), a `candidate` JSON note
or writer envelope, and `expected`: `{"outcome":"commit"}` or
`{"outcome":"refusal","code":"CONTEXT_..."}`. Only `PROJECT_CODES` may occur;
message text is never compared. A commit means these deterministic checks passed,
not that the runner wrote storage or called a model.

Additional inputs are stage-specific:

- `note`: envelope removal then note validation. Optional `diagnosis` pins the
  schema counts, scope counts or quotation class, so equal refusal codes cannot
  hide the wrong planted fault. `budget` freezes `threshold`, `sourceTokens` and
  `previousTokens`, with the expected tier, base and hard limit. To avoid pages of
  repeated filler, `candidateBytes` expands the candidate with ASCII `x` in state
  facts (each at most 4,000 characters), preserving its source IDs, to that exact
  serialized UTF-8 byte count. `materializeCandidate` defines this expansion.
- `sources-repair` / `quote-repair`: `response` is the single scripted repair.
  Eligibility and splicing use the core functions; the repaired note passes full
  validation. No other repair or retry is attempted.
- `tool-pairs`: message records project to their `message` objects and pass
  `assertToolPairs` from `src/guards.ts` before the candidate passes note
  validation. This is the core's tool-pairing guard, the same function the
  preview uses, so the vectors exercise the shipped pending-call rules.
- `checkpoint`: `checkpoint` supplies pinned `sourceHashes` for `pi` and/or `jcs`,
  optional `continuation` IDs and whether its exact rendering is included.
  `runCoreVector` builds the stored rendering and metadata, then calls
  `validateMemoryCheckpoints`. For changed-content vectors, `originalRecords`
  must first reopen successfully with the very same pinned hash and note; only
  then are the changed `records` checked. The quote still matches after the edit.

The set includes the required faults and deliberate boundary pairs: absent/empty
sources, missing/unreadable IDs in both citation fields, three quotation classes,
each envelope and its extra-key near miss, exact hard-limit/one-byte-over notes
on both sides of every source-tier transition, protected repair loss, a complete/
unpaired tool batch, a present/missing continuation rendering, and changed cited
content under both source serializations. No vector combines independent faults.

`src/canonical.ts` implements RFC 8785 over JSON values. The normalized record
contains every structural field from `records.ts`; host-only record/message keys
are excluded, while opaque blocks, arguments, details, data and replacements
remain whole. Optional structural fields absent or `undefined` are omitted; JSON
payloads must be valid JSON. Keys sort by raw UTF-16 units; strings are never
Unicode-normalized. Each JCS record is followed by LF before SHA-256. Pi keeps its
existing native `JSON.stringify` framing; checkpoint readers select JCS explicitly
(`latestMemory`'s second argument, `validateMemoryCheckpoints`' third argument).

Run `node scripts/context-memory-core-check.mjs` from the repository root for the
import gate, in-place vectors, isolated build and isolated vectors. The required
repository acceptance is `node scripts/context-memory-ops.mjs verify`.
