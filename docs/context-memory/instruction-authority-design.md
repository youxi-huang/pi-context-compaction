# Instruction-authority gate design

Status: design proposal for the dedicated instruction-authority milestone in the
[roadmap](roadmap.md). Its release number is unassigned. No runtime change,
checkpoint migration, new input protocol or arm B experiment is enabled by this
document. The maintainer has selected preparation of a compatibility bridge and
minimum supported rollback reader. Intake/projection enablement and release
identities remain separate decisions.

Latest handoff direction: the maintainer authorizes reassessing or deleting this
design. The complete strict protocol and unused prototypes are not presumed
necessary for B's first candidate-data experiment. Evaluate the narrower
[cloud handoff](claude-handoff.md) first; retain any required mechanical boundary
and explicitly defer stronger promises. Ordinary input should not acquire a
mandatory repeated review workflow.

The proposed minimum for this stronger protocol is an explicitly entered authority mode with trusted user
adoption receipts and a host-derived active-rule set. Model-written notes remain
evidence in every section. Only the host can place adopted source spans in the
instruction lane, and it renders those spans without model paraphrasing.
Existing prose sessions cannot be given this guarantee retrospectively from
message roles or quotations alone.

## The gap in the current implementation

The current note schema has six fact sections: `instructions`, `failedPaths`,
`reasons`, `state`, `nextSteps` and `files`. Each fact has free text and sources,
with optional quotation and `supersedes` references. `gaps` is free text without
source references. Validation checks readable sources, exact quotations, size
and restored rendering; it does not prove that an instruction is authorized,
that its cited evidence supports its meaning, or that a later ruling preserved
its authority.

`renderNote` prints model text directly under section headings. Lineage copies
opening sentences of older `state` items. Pending `context_note` candidates are
also rendered into context. The current `convertToLlm` converts custom messages,
branch summaries and compaction summaries into provider `user` messages. Thus
provider role cannot recover the original text's authority, and protecting only
the section named `instructions` leaves several promotion paths open.

The [validation record](validation.md#v023-budget-and-recovery-checks-2026-09-13-utc)
already describes an internal writer instruction being recovered as a user
restriction despite passing numeric recovery assertions. A prompt correction
and targeted rerun addressed that observed pattern; neither constitutes a
mechanical authority contract.

Current arm A and the synchronous writer have these limitations. The new
latency work does not establish authority labels by recording
`processedUserEntryIds`: that is a delivered-source horizon. It is not approval
of source contents. Arm B adds model-authored per-turn material and, with a
fixed writer, changes the preparing role. The roadmap requires the dedicated
authority gate before that experiment. An existing optional `context_note`
tool does not satisfy the prerequisite.

## Bounded claim and trust boundary

The mechanical claim is about admission and projection: specified evidence-only
source classes cannot create, modify, revoke or inherit host instruction records,
and model-generated text cannot become host instruction text through any note
section, lineage, pending candidate or continuation helper.

The claim does not guarantee that a model obeys the projection, understands every
scope correctly, preserves all facts, or chooses an authorized action. A JSON
envelope, a warning paragraph or a provider message role is not enforcement of
model behavior. Authority records also do not replace host tool permissions.
Recovery and actual continuation remain separate measurements.

The trusted base is the supported host, this extension's deterministic intake,
and the user's expressly supported approval surface. Initial scope remains one
writing process on official Pi 1.1.0 with persistent text sessions. Arbitrary
other extensions, SDK clients impersonating interactive input, and code that can
rewrite the host or its authority records are outside this origin guarantee.
Hashes establish binding and detect specified source changes; they are not proof
of an authentic human origin against such a local actor.

The public `input` event exposes `interactive`, `rpc` and `extension` sources.
That helps reject unsupported routes but is not sufficient on its own: input
handlers can transform text, and SDK prompt callers choose an input-source
argument. Registered slash commands also execute before the normal input event.
The implementation must establish a supported origin-binding path rather than
assuming that a command handler, `role=user`, a custom entry type or an
`interactive` string authenticates approval.

## Trusted intake: a product decision, not an inferred label

Ordinary user messages can contain a task, a quotation, a document to analyze,
and contrary examples in the same text. There is no general deterministic parser
that distinguishes their intended authority. Do not auto-label ordinary prose
as instruction, and do not treat punctuation, code fences or a string blacklist
as the missing proof.

The recommended first intake is an explicit interactive review/adoption surface:

1. The user selects exact source spans or enters directive text, chooses a rule
   key and branch scope, and explicitly adopts, replaces or revokes it. The
   surface displays the exact text and scope being adopted. Approval is a direct
   supported user action; model tools cannot supply it.
2. The host validates the operation and source span, appends a source-linked
   adoption receipt, and confirms that receipt from the original session records.
   Adoption of quoted material is a new user act; the quotation itself never had
   instruction authority.
3. The command or review handler sends no generation request. A model-facing
   `context_note` invocation cannot create these receipts. Any API that accepts
   adoption must be separately authenticated or remain unsupported.

The exact UI/command protocol is not selected here. A stock-Pi implementation may
use a reserved input handler that consumes the operation and a direct interactive
confirmation, with supported input-handler ordering and no transformation after
approval. It must not simply register a command and presume the otherwise missing
origin metadata. If stock public APIs cannot prove this supported route, the
choice is a narrow host provenance change or keeping the gate closed, not an
origin-label guess.

Receipt storage is part of the original append-only session records, not a second
history database. A derived active-rule index can be deleted and rebuilt. The
receipt type is controller-owned; candidate JSON cannot claim to be one. Binding
to source hashes and a trusted intake path is mandatory, and custom-type naming
alone is not authentication.

## Public-API feasibility and remaining compatibility dependency

Read-only inspection of the actual official Pi 1.1.0 npm cohort first established
the following possibilities. Subsequent bounded bootstrap and bridge-refusal
experiments are recorded in [validation](validation.md#unreleased-authority-bridge-and-public-api-prototypes).
They are synthetic component proofs, not an enabled authority UI or a completed
intake/projection/rollback milestone. The public renderer limitation below is a
later correction to the initial source-only assessment.

| Public path | Usable contract | Required proof or limit |
| --- | --- | --- |
| `ctx.mode` plus `input.source` | Reserve an unregistered input protocol only when mode is `tui` and source is `interactive` | `hasUI` alone admits RPC dialogs. SDK clients can supply origin/mode values and remain outside the stated local-actor guarantee |
| Direct TUI `ui.input` / confirmation | Collect exact directive text, scope and operation through a supported user action | A registered command may launch this surface, but its invocation is not approval; escape control characters and display the exact approved bytes/scope |
| `input` result `{ action: "handled" }` | Consume an unresolved, cancelled or unsupported strict input without running the task | Input handler errors are reported and swallowed; throwing is not a dispatch guard |
| `pi.appendEntry` in an existing flushed session | Append receipts to the original session stream, then independently confirm them | Calls append in memory before persistence; synchronous return is not disk confirmation |
| `ExtensionCommandContext.newSession({ setup })` | Await a public setup callback with a full public `SessionManager`, without starting a provider | Stock may already append source-free model/thinking configuration; bind and narrowly validate that prefix. `appendMessage(user)` can trigger first flush before custom receipts; pure custom-entry intake cannot |
| `context_with_system` plus final payload guard | Render and validate classified ordinary messages and host active rules through the same projection | Bind source/receipt identities, preserve host/tool declarations and abort an active request on mismatch |
| `before_agent_start.systemPromptOptions` | Control a bounded host prompt policy | Excluding `contextFiles` alone misses opaque custom/append/forced prompts and custom sections/skills. Official Pi 1.1.0 does not publicly export its `buildSystemPrompt*` helpers; do not treat physical internal renderer files as a public SDK contract |

The stock session manager considers an original user **or** assistant message a
conversation for first flush. Appending only custom source/receipt entries in a
fresh session buffers them without creating a confirmable file. A pure consumed
input protocol therefore cannot claim durable fresh-session enrollment. Public
`newSession({ setup })` is a concrete alternative: append the approved original
user source, append its host receipt, independently reread and bind both, then
construct and confirm the initial authority seal. This changes the entry
experience and still requires a finite offline prototype before adoption.
Use the setup callback's supplied manager throughout bootstrap and the public
replacement context afterward. A command context or captured `pi.appendEntry`
closure from the previous session must not write the new session's receipts.

An initial seal can retain the legacy-visible `kind` and `stock-preview+` build
discriminator while using a separately versioned authority projection. After a
successful saved seal on the selected branch, old preview request,
explicit-compaction and recovery validation sees its ownership and rejects the
unsupported checkpoint before starting another compaction. Recovery removes a
matching marker, not that checkpoint. Navigating to an ancestor before the seal
is different: the old reader recognizes session protection from all entries,
but validates checkpoints only on the selected branch. That branch can lack the
unsupported seal and admit legacy requests. The seal is therefore only a
candidate branch-local success-path bridge, not a complete rollback solution.

Failure before that seal reaches disk leaves a harder interval: proposed
receipts or an unknown marker alone can still be ignored or overwritten by the
old reader. Do not define this interval away or claim that successful setup proves
failed-enrollment protection. The recommended next design is a compatibility
bridge that recognizes session-wide pending/active strict ownership, including
navigation before the seal and fork operations, and refuses unsupported explicit
retry/recovery, with a declared minimum compatible rollback reader. A later
bridge cannot retrofit already released old binaries. The maintainer has selected
the bridge/minimum-reader policy: released v0.3.3 is outside the supported rollback
range for authority sessions. No new release number is assigned. Strict enrollment remains disabled until
its entire interruption matrix satisfies that policy.

Receipt readback and checkpoint confirmation retain the preview's declared
stock-Pi persistence scope; stock appends are memory-before-write and are not an
fsync/crash-durability promise. The new contract must state its durability scope
and any additional bounded flush requirements explicitly, without substituting a
second history store or calling private host persistence methods.

Finally, `before_agent_start` throwing is swallowed by the runner and aborting
there can be reset before the agent run. Use consumed input for review/cancel
paths and independent active-request guards at context/payload boundaries. A
review UI that merely reports a problem while allowing the provider to run does
not meet the proposed strict horizon contract.

## Selected bridge contract for the offline prototype

The minimum compatible reader is a capability requirement, not an assigned
release number. A bridge-only reader understands strict ownership and refuses
to run the session; a future authority reader additionally validates its intake,
receipts, horizon and projection. An active seal does not give the bridge-only
reader permission to use legacy notes. A later bridge cannot protect a deliberate
downgrade to a binary outside this supported range or removal of all protection.

The proposed enrollment ordering is:

1. Obtain the new public setup manager's session/file identity. Persist a bounded,
   content-free pending ownership barrier before appending any approved source or
   receipt. Failure here stops enrollment; there is no approved source to submit.
   Inside the supplied setup callback, append a bounded content-free incomplete
   enrollment sentinel before rethrowing. A private latch on the old reader
   object alone does not protect the already-created replacement reader. The
   sentinel is an ownership refusal, not a receipt or fake user message; custom-only
   stock buffering preserves it in the active manager without claiming a disk
   flush. Do not reuse the ordinary compaction attempt marker for this barrier.
2. Validate and bind the new manager's complete source-free initialization prefix.
   Official SDK setup can already contain model/thinking configuration entries;
   it is not a zero-entry manager. The prototype permits only an explicitly
   checked stock configuration prefix, never prior messages, custom records or
   checkpoints. Append the controller-owned ownership claim before every source
   or receipt. Its session/policy/enrollment/prefix identity binds the pending barrier. Custom-only
   entries may still be buffered; this is why the barrier precedes them.
3. Append the genuinely reviewed user source, which can trigger stock first flush.
   Independently read the original file, header and complete claim/source records.
   Append and confirm receipts and the initial seal in sequence. Each step can
   fail after the host has already changed its in-memory tree.
4. Update the barrier only after exact saved-seal confirmation. The pending
   barrier is never deleted to convert a failed enrollment into a legacy session.
   Source/receipt recovery requires an authority-capable protocol; ordinary
   `/compact` or `/compaction-recover` cannot perform that transition.

The barrier stores identifiers, protocol/capability discriminators and binding
hashes, not source text, rule text or a second transcript. Original claims,
sources, receipts and seals remain in Pi's original session stream. A completed
claim permits reconstruction of operational ownership metadata, but missing,
invalid or inconsistent metadata never establishes readiness. Lost metadata
before first flush has the same explicit local-storage boundary as other preview
operational markers; do not infer an fsync guarantee for stock session appends.
If neither barrier nor original records reach disk, no restart-durability claim
is possible. The replacement/reload path must nevertheless see the incomplete
sentinel in its existing manager; no source is dispatched under a silent legacy
fallback. A fresh independently constructed reader seeing only an unmarked
configuration prefix cannot reconstruct that failed user intent.

| Observed state | Bridge-only reader result |
| --- | --- |
| No barrier and no ownership claim | Existing legacy behavior |
| Pending barrier, no original file yet | Strict/unsealed; refuse execution and legacy recovery |
| Claim or receipt-only tree; no saved seal | Strict/unsealed; refuse execution and legacy recovery |
| Saved matching active seal | Strict/active; unsupported projection; refuse execution |
| Unknown protocol, malformed claim/barrier, mismatched session/source/seal | Strict/invalid; refuse without overwriting evidence |
| Current branch precedes the seal or has no selected leaf | Session-wide strict ownership still applies |
| Copied claim has another owning session | Refuse; a fork does not inherit an instruction grant |

Ownership inspection covers all original entries, not just the selected ancestor
chain. The claim must precede every strict task source; source-free configuration
ancestors remain covered by session-wide ownership. The initial
prototype cancels tree and fork operations rather than attempting branch-local
authority transfer. Switching away can remain possible; a loaded target must
be checked before any request. Unknown or unreadable ownership is a refusal,
not a reason for the extension to stand aside.

Guard placement precedes `safeInactive`, native-compaction fallback and every
ordinary failure-store `begin`, `recover` or reset. Refusal must use the public
operation's cancellation result where available. Active request guards must
abort; a swallowed exception, `before_agent_start` error or notification alone
does not prevent dispatch. Unresolved/unsupported input is consumed with
`action: "handled"`. Cache warming stops explicitly because it bypasses agent
request hooks. Stock cache-warming overrides are last-wins: a later extension can
replace `stop`. The supported configuration must therefore establish a reviewed
extension set and final guarding order, or keep warming unavailable; the isolated
prototype does not prove safety under arbitrary competing handlers. History and note tools cannot mutate strict state through a legacy
controller. Read-only status may report a fixed ownership state/code without
calling ordinary recovery or leaking receipt/source content.

Register these protections before the ordinary `enabled: false` early return.
That setting disables legacy compaction, not strict ownership compatibility.
Config errors, unsupported host versions and reloaded extensions also cannot
silently downgrade an owned session. These are prototype requirements, not a
claim that the current package already implements this guard set.

## First intake proposal and the next public-API proof

The maintainer selected interactive review after ordinary input for the next
offline prototype, within the proposed limited prompt/tool and tree/fork scope.
The first product-flow proposal is opt-in TUI enrollment in a new session.
A launcher command opens a direct review surface; the command's input source is
not approval. Show task data and each proposed rule separately, with exact escaped
text, rule key, branch scope and explicit confirm/cancel. Bind the complete source
and the displayed operations before replacing the session. Store original text
blocks without normalization; source spans name the block and UTF-8 byte range.
Classification covers every block completely, including the data remainder.
The ownership prototype's seal confirms ownership only; it contains no active
rules and cannot replace the proposed authority checkpoint.

The finite bootstrap proves only the first new-session setup path. Later turns
need their own admission proof. Public `pi.appendEntry` stores custom records and
does not append a native user message; `pi.sendUserMessage` always triggers a
turn. Do not assume a consumed review handler can append a normal user source
without dispatch, or retain an old full manager after replacement.

A next offline experiment may review ordinary input, freeze its exact text and
operations, and allow only the unchanged native input through the supported
handler chain. At the first active context boundary, bind its actual host-assigned
entry ID/hash, append and independently confirm the eligible receipts, and build
the classified projection before any provider transport. A missing source,
transformation, stale approval or receipt IO failure aborts the active request;
cancelled and unresolved review stays `handled`. Persisted intents that precede
the actual source are not eligible receipts and cannot resolve a restart horizon.
This is a proposed proof path, not permission to dispatch an unclassified turn.

Initial support should use one reviewed extension set and source-proven host/tool
prompt construction. The current public prompt options flatten some project,
skill and custom contributions. Specify which are excluded or separately adopted
before offering strict mode; clearing project context files alone is insufficient.
The initial bridge reader cancels tree/fork, and the first authority intake should
retain that limit until a branch-transfer/replay policy is proved. These changes
have been selected for prototype preparation; product enablement and exact
supported contributor identities remain subject to evidence and review.

## Minimal receipt and active-rule contract

The following fields describe proposed contracts, not the existing checkpoint
format. All identifiers and limits are assigned or checked by extension code.

| Field | Meaning and validation |
| --- | --- |
| Policy identity | Intake, receipt and projection policy versions; unsupported versions fail closed |
| Receipt identity | Host-assigned unique receipt ID, owning session and parent entry/branch identity |
| Operation | `adopt`, `replace`, `revoke` or `classify-data`; replacement targets are explicit receipt IDs, and data classification never alters the active rule set |
| Origin | Supported intake route and its bound approval event; never supplied by the note candidate |
| Source binding | Original entry ID, original-entry hash, text-block index, exact text span and span hash; offsets use one specified Unicode/byte convention |
| Rule identity | User-selected key; at most one active value for a key within the declared scope |
| Scope | Explicit owning branch and rule scope; the first candidate supports branch-local session rules only |
| Lifetime | Start receipt position and explicit replacement/revocation positions on that branch |
| Approved text | Exact adopted bytes recovered from the bound source span, without model rewriting |
| Classified horizon | Host-verified original user entry/span membership and binding hashes; only exhaustive approved partitions resolve an ordinary user entry |

Offsets must be defined consistently; UTF-8 byte offsets into the explicitly named
stored text block are a concrete option. A string content has one block; a
multi-part text message names each block by its original index. Validate boundaries, disjoint directive/data spans,
source hashing and exact extracted bytes before admitting a receipt. Avoid
searching for the first occurrence of a repeated quote as an identity rule.
Bind the complete original entry hash as well as the span. If UTF-8 offsets are
chosen, reject ambiguous or lossy mappings such as an unpaired surrogate in an
adopted span; do not normalize original text to make an approval fit. Evidence
can retain its escaped original representation without acquiring authority.
An intake operation may use a controller-owned original entry for text entered
in the review surface rather than an earlier ordinary message.
An ordinary user entry's resolved classification is a complete, disjoint span
partition into adopted directives and explicitly reviewed data. No uncovered
bytes are implicitly approved. Persist `classify-data` records in the original
session stream so restart can reconstruct a data-only review or the data
remainder of a mixed message. Data classification is an original user review
act, not a field that the preparing model may fill in. The host marks a horizon
resolved only when the bound source and its complete partition validate.

Rebuild the active set by replaying eligible receipts on the current ancestor
chain in source order. `replace` atomically retires its explicit active targets
and installs the new value. `revoke` retires its explicit target. Neither a model
`supersedes` field nor a statement of completion can retire a receipt. Reject
unknown, out-of-branch, already-inapplicable or unauthorized targets under the
declared operation policy. Different rule keys may contain semantically
conflicting prose; the host cannot claim to detect that generally. The review
surface must make replacement targets visible.

A project file is evidence unless the supported user/host path adopts specific
spans with an explicit scope and snapshot. `isProjectTrusted()` indicates host
project trust, not approval of every instruction in every file. The minimum can
adopt project-derived text into the current branch as a user rule, but it cannot
claim hierarchical project-rule inheritance. Supporting project/directory scope,
file replacement and inheritance needs a separate applicability contract with
canonical paths and scope narrowing; missing support cannot silently widen scope.
Branch navigation rebuilds the selected ancestor set. Forks have no inherited
instruction grants unless an explicit supported adoption establishes them.
Retrieval grants authorize reading evidence and never convey instruction rights.

## Later user input and the unclassified horizon

The exact adoption/replacement/revocation protocol gives mechanical ordering.
It does not make arbitrary later prose revocations detectable. After a new
ordinary user entry, the authority horizon is unresolved until the trusted intake
classifies its relevant spans or explicitly confirms that it contains data only.
The user may replace an earlier rule, adopt a new directive, or label quoted
material as evidence. The model cannot make that classification authoritative.

Unresolved input invalidates full authority candidates immediately. Do not
silently retain old permissions as current, drop old restrictions, or let a
same-writer merge self-certify resolution. In strict authority mode, a checkpoint
claiming a complete active-rule set cannot commit until the horizon is resolved.
An actual failed compaction preserves the existing blocking/recovery lifecycle.
The recommended strict intake also pauses ordinary provider dispatch until
review resolves the new input. Retaining a possibly revoked permission in the
next request while merely disabling compaction would contradict the current-set
claim. Keep the originals and existing receipts intact for review, but do not
render the old active set as current or silently dispatch under the legacy
contract. Review itself calls no model. This is an authority-review state, not a
failed compaction: it must not enter the compaction store's pending/blocked
lifecycle. A preexisting compaction failure remains separately blocking.
The maintainer must approve this ordinary-request consequence along with intake;
the current preview does not implement such a pause.

This creates a deliberate usability cost. A structured turn envelope that makes
directive/data selection part of each submission could avoid repeated review,
but it is a new interaction protocol. Quietly auto-classifying ordinary user
messages would abandon the bounded guarantee. The maintainer must choose the
supported strict-mode intake experience before implementation.

## Projection contract covering every recovered field

Use two mechanically distinct containers in the authority-aware checkpoint:

- **Host instruction state:** active receipt references plus a host-derived
  manifest/hash, authority horizon and policy identity. The renderer resolves
  each active rule's exact adopted bytes from originals and emits its scope,
  ordering and current status. The model emits no free text into this container.
- **Evidence and proposed work:** all model-written note fields, including
  `instructions`, `failedPaths`, `reasons`, `state`, `nextSteps`, `files` and
  `gaps`. These can support facts or propose actions; none creates authorization.

For a minimum transition, the familiar section names may remain in the candidate
payload while the host projects all of them as evidence. Rename the displayed
`instructions` group to attributed statements or evidence instructions, rather
than presenting it as another source of current rules. The candidate may cite
receipt IDs as data, but cannot copy them into an authoritative active set.

Serialize each model string as data within a deterministic envelope. Newlines,
headings, delimiter-like text and nested role labels cannot escape that envelope
or become host-owned framing. `gaps` remains a model observation; to preserve an
unsourced empty-state transition the host can supply a fixed placeholder rather
than have the model invent an instruction. No string classifier is required to
recognize imperative language: every model-written string takes the evidence
path regardless of its section or wording.

Apply the same rule to all secondary paths:

| Path | Required authority-aware behavior |
| --- | --- |
| `context_note` and arm B output | Accept evidence payloads only; reject attempted receipt/active-set fields; validate source links before use |
| Pending candidates | Render through the evidence projection, including during ordinary requests, rather than the current unrestricted note renderer |
| Final writer and size repair | Generate/repair evidence only; host instruction state is recomputed independently and cannot be shortened or rewritten by repair |
| Checkpoint lineage | Keep anchors and evidence labels; old `state` prose cannot acquire active-rule status by being host-assembled |
| Continuation helper | Distinguish adopted directive spans from quoted/data spans; never treat an entire original user message as approved instruction |
| Retained recent context | Keep original order and source classification; raw newer text does not automatically resolve the strict authority horizon |
| History retrieval | Return source identity and classification as host metadata; evidence reading does not adopt it or expand scope |
| Custom `/compact` instructions | Affect compaction focus only unless a separate trusted adoption creates a task rule; internal writer controls are never task receipts |

The same renderer and classified horizon govern ordinary requests, before any
checkpoint exists. A reviewed data span in an original user message cannot
regain instruction-lane status because stock Pi transports the original message
with `role=user`. Define the deterministic projection for classified mixed
messages and validate its exact output at the final provider guard. A checkpoint
renderer alone is not the all-path contract.

Audit the initial system prompt too. Stock Pi can include project/context files
there; the proposal's explicit project adoption rule cannot coexist with an
unchanged system prompt that already presents unadopted file text as instructions.
Preserve host-owned base/tool policy and explicitly separate adopted project
spans from evidence, using supported prompt construction/override APIs. Bind the
policy and source snapshots into the projection identity. If public APIs cannot
reconstruct that distinction, narrow the claim explicitly or keep the strict
gate closed rather than treating a system message as origin proof.

Stock Pi still transports the compaction summary in a provider user message.
This design promises deterministic lane admission, not a provider-native security
boundary. The renderer must not describe its evidence wrapper as proof that the
model will disregard instructions embedded in the data.

Active adopted rules must fit the declared recovery budget together with evidence,
system/tools and retained messages. Do not drop a restriction, truncate adopted
text or keep only an affirmative permission to obtain a smaller note. If exact
active rules cannot fit, retain the originals and refuse the authority handover.
Reject generated items claiming receipt authority even if their quotations match.

## Checkpoint and prepared-candidate compatibility

An authority-aware checkpoint must record the policy identity, receipt horizon,
active receipt IDs, their source binding/hash and a deterministic projection
identity in addition to existing source coverage. These fields are host-derived
and are checked against the complete branch during preparation classification,
stage, disk confirmation and fresh-process reopening. A changed rule set or
unclassified later input invalidates a completed candidate even when its original
source prefix hash still matches. Replay revocation on the current branch;
persisted active IDs alone cannot revive retired authority.

Legacy checkpoints have no trusted receipts. They stay readable under their
legacy implementation and do not inherit an authority-verified label. Their
model text can be evidence for an explicitly reviewed transition, never the
source of reconstructed user approval. No migration rewrites original sessions.
The minimum strict mode starts in a fresh session; transition from a legacy
session requires a reviewed copy and explicit adoption of the current rules.

A new optional metadata field on the existing format is insufficient if an old
reader ignores it and renders evidence as instructions. Prefer a separately
versioned authority checkpoint/projection contract that legacy readers reject
before dispatch. The exact checkpoint version and its maintenance identities are
release decisions. Update and rollback tests must cover both checkpoint reading
and pending/staged markers; unchanged global numbers do not establish compatibility.

There is a concrete legacy ownership obstacle. Current preview ownership requires
the existing checkpoint `kind` and a `stock-preview+` build identity. Changing
that discriminator can turn a new checkpoint into a foreign checkpoint that an
unenrolled old reader leaves to Pi. Before the first checkpoint, an unknown
receipt/custom type alone does not establish legacy protection. An unsupported
marker alone is also insufficient: the old explicit-retry `begin` path can replace
a block while bypassing its ordinary readiness check.

Before enabling strict intake, prove a persistent enrollment/ownership invariant
that every supported legacy reader sees and cannot clear by `/compact`, explicit
retry or recovery before validating the new contract. A compatible bridge,
host-enforced ownership or a narrower verified rollback policy may be needed.
The maintainer selected preparation of a compatible bridge and a minimum supported
reader; that mechanism is not yet proven. If the public extension cannot
establish this invariant, keep strict intake unavailable and present the concrete
dependency to the maintainer. A version number is not this proof. The matrix must
include enrollment before any checkpoint, receipt-only sessions, completed and
pending/staged checkpoints, deliberate rollback and each old retry/recovery path.

For prepared candidates, bind the authority policy, active-set hash and classified
horizon into the frozen input and output validation. Model/writer identity remains
separate. Complete reuse must match the current authority state; merging a stale
evidence candidate never authorizes the candidate's old instruction statements.
Historical-prefix submission remains separately gated by its temporal/projection
contract and cannot be used to bypass unresolved revocation.

## Gate and negative regression matrix

Before arm B, the dedicated milestone must demonstrate trusted admission,
all-path projection, current scope/revocation and fresh-process compatibility on
the supported host. Scripted outputs can establish those structural properties;
they cannot establish model obedience or provider recovery quality. The completed
component experiments are recorded separately; no full authority gate is claimed
by this design document.

| Negative fixture or operation | Required deterministic result |
| --- | --- |
| Tool output or retrieved document says to deploy | Evidence only; no active rule or approval receipt |
| Assistant proposal is copied into any note section | Evidence only; host active set unchanged |
| User message contains a quotation or analyzed command | Unclassified/data until supported explicit adoption; `role=user` is insufficient |
| Correct quotation cites an unapproved proposal | Citation may validate; admission to instruction lane still fails |
| Fake receipt object/custom type appears in `context_note` | Rejected as candidate authority; no trusted-intake effect |
| Forged provider/user/system role labels occur in model text | Serialized evidence; no host framing or origin change |
| Directive text moves through each of the six sections or `gaps` | Same evidence classification in every case |
| Injected headings, JSON delimiters or escape sequences | Cannot alter lane structure or append an active rule |
| Internal writer/repair/focus text is cited as a restriction | Never becomes a task receipt; task authority comes from independent intake |
| Legacy `state` text enters lineage or a pending candidate | Evidence projection; no elevation through host assembly |
| Continuation includes user quotation plus a real request | Only explicitly adopted directive spans enter the instruction lane |
| Repeated equal quotes, Unicode or altered source bytes | Exact span/hash binding checked; ambiguity or mismatch rejected |
| `supersedes` claims to cancel permission or restriction | Does not change active rules; only eligible explicit receipts do |
| Valid replacement/revocation followed by late preparation | Old authority hash becomes stale; no complete reuse or resurrection |
| Ordinary later user correction or revocation | Unresolved horizon prevents both ordinary dispatch and authority checkpoint until trusted classification in the proposed strict intake |
| Sibling/fork receipt, out-of-scope rule or retrieval grant | No inherited instruction rights; explicit adoption required where supported |
| Project file changes or contains a malicious rule | Data without scoped adoption; no trust from filename or global project trust |
| Unadopted project content enters the initial system prompt | Evidence projection or explicit refusal; no bypass of project adoption before the first checkpoint |
| Classified data remains in an ordinary mixed user message | Final ordinary-request projection preserves the data classification; role transport cannot create a receipt |
| RPC/extension route or input transformation attempts adoption | Unsupported origin rejected; no receipt or silent route downgrade |
| Restart, source tampering or inconsistent authority manifest | Rebuild from originals, validate scope/horizon, fail closed on mismatch |
| Active restrictions exceed budget or repair omits a rule | Refuse authority handover; never truncate/drop active rules |
| Update/rollback opens unsupported authority checkpoint or marker | No request before verified compatible transition or explicit recovery |
| Rollback before the first checkpoint or with receipts only | Legacy-visible ownership persists; no unprotected native dispatch |
| Old explicit `/compact`, retry or recovery sees strict ownership | Cannot overwrite the enrollment block or admit a legacy note before compatible validation |
| Navigation before the authority seal or fork from that ancestor | Session ownership remains enforced; no unclassified legacy projection or silent loss of branch-local authority policy |
| Gate incomplete while arm B is configured | No session-model increment experiment dispatch |

Separately measure semantic confusion with later rulings, revoked scope, task
continuation and proposed actions. Keep those results distinct from structural
admission tests. A provider passing a fixture does not enlarge the mechanical
claim. Authority handling is required for arm A too once strict mode is selected;
it is not an exception reserved for B or a retroactive guarantee for current A.

## Decisions to present before implementation

| Decision | Reviewable options | Recommendation |
| --- | --- | --- |
| Intake experience | Explicit interactive adoption/review; structured directive/data turn envelopes; retain ordinary prose and keep B gated | Start with opt-in interactive adoption and fresh sessions, pausing ordinary requests at an unresolved horizon; do not pretend this preserves the ordinary prose experience |
| Host origin path | Prove supported stock-Pi interactive binding; add a narrow host-origin change with delta/fingerprint coverage; leave authority mode unavailable | First validate the supported public path; if it cannot establish the stated origin contract, present the concrete host delta before changing scope |
| Instruction text | Host renders exact adopted spans; model paraphrases spans with approval review | Exact spans for the minimum mechanical gate; evaluate note size/usability costs explicitly |
| Project rules | Explicit branch-local adoption; scoped project inheritance with separate applicability contract | Branch-local adoption first; unsupported project inheritance stays evidence |
| Persisted format | Distinct authority checkpoint/projection version plus proven legacy-visible enrollment; a compatible bridge or host-enforced ownership; leave strict intake unavailable | Require refusal before the first checkpoint and through old explicit retry/recovery, fresh sessions first, reviewed-copy transition later |
| Release scope | Deliver the dedicated authority milestone before B; explicitly defer B and adjust the comparison scope through the maintainer | Keep the roadmap dependency intact; this proposal neither enables B nor changes the v0.4.0 comparison |

These decisions change user interaction and persistence semantics and belong in
the maintainer's final review. The current authorized latency work can continue
without selecting them or claiming this gate has passed.

The maintainer has retained the v0.4.0 A/B comparison and selected completion of
this prerequisite design as the next stage. That scope decision does not approve
a particular intake UI, new format, host delta or live B experiment. Establish
the public-API and rollback feasibility above before enabling the milestone.

The maintainer subsequently authorized the compatibility bridge and minimum
supported rollback-reader scope, including a bounded offline prototype. This
permits preparation of bridge-only refusal and public bootstrap experiments. It
does not approve an intake UI, a checkpoint version, strict ordinary projection
or B dispatch. Authority sessions may be reopened only with a supported reader
that understands their session-wide ownership; deliberate rollback to released
v0.3.3 is unsupported and cannot be made safe by later extension code. Legacy
sessions retain their existing rollback contract.

The maintainer subsequently chose a staged A-only `v0.4.0-preview.1` delivery and
paused further B implementation. The ordinary-input review choice remains the
next-session design direction, not an implemented UI. Completed ownership and
public-API prototypes are retained; receipt replay, projection and B dispatch
remain closed. Source inspection also corrected an earlier feasibility assumption:
official Pi 1.1.0 does not export `buildSystemPrompt`, `buildSystemPromptSections`
or normalization helpers from its public entry points, and has no public
system-prompt subpath. Its internal renderer files are not a public API.
Public `refreshContext()` refreshes the projection without generating persisted
system sections. Resolve this concrete prompt/parent-binding dependency before
claiming a complete ordinary-input intake path.

The retained next-session kernel sketch uses privately branded immutable live
approvals and replay results, exact whole-source/body/text-block span hashes,
exhaustive directive/data partitions and explicit prior-active targets for
replacement/revocation. Source binding must compare the full pre-source prefix
hash and actual native source at the branch tip; the receipt is initially an
unpersisted plan and cannot establish readiness before independent readback.
No kernel implementation was created in this tranche. Stock may insert a native
system update between input review and user append; do not relax the captured
parent to make a test pass. `message_end` also precedes native persistence, so
binding belongs at the first active context boundary. Forced prompt projection
can run after `context_with_system`; final provider payload verification remains
mandatory. The initial no-tools fixture cannot prove tool-pair or new-checkpoint
compatibility. These are the concrete next proof tasks, not completed capabilities.

The next-session sequence is:

1. Specify the selected minimum compatible rollback policy and proposed strict
   intake. Define the
   ownership bridge, limits and all interruption/navigation/fork cases before
   assigning format or release numbers.
2. Build one bounded offline public-API prototype for TUI origin checks, consumed
   input and `newSession({ setup })` source/receipt readback. Test cancellation,
   partial writes and stale replacement contexts without a provider call.
3. Establish the ownership barrier on every supported reader, including failed
   bootstrap and old explicit retry/recovery. Keep authority mode disabled until
   the matrix passes; successful bootstrap alone is insufficient.
4. Implement exact span replay and the ordinary/checkpoint/provider projection,
   including every model note field and opaque project prompt origins. Bind
   candidate freshness and budgets to that policy.
5. Run the dedicated structural authority acceptance separately from semantic
   continuation. Only then declare B's per-turn generation/tool budget and add
   it to the same v0.4.0 comparison; source/quote validity never substitutes for
   the authority gate.

## Inspected sources

- [Roadmap](roadmap.md): dedicated authority milestone, arm B prerequisite and
  separate recovery components.
- [Notes](../../packages/coding-agent/src/extensions/context-memory/notes.ts):
  schema, source/quotation validation, rendering, lineage and continuation.
- [Preview controller](../../packages/coding-agent/src/extensions/context-memory/preview/controller.ts):
  pending note injection, delivered user horizon and commit paths.
- [Preview extension](../../packages/coding-agent/src/extensions/context-memory/preview/extension.ts):
  `context_note` registration and current public lifecycle events.
- [Preview writer](../../packages/coding-agent/src/extensions/context-memory/preview/writer.ts):
  writer control rules, size repair and session-prefix mode.
- [Provider message conversion](../../packages/coding-agent/src/core/messages.ts):
  custom/branch/compaction content becomes provider user messages.
- [Public input types](../../packages/coding-agent/src/core/extensions/types.ts),
  [input handler chain](../../packages/coding-agent/src/core/extensions/runner.ts)
  and [prompt routing](../../packages/coding-agent/src/core/agent-session.ts):
  available origin labels, input transformations and command-before-input order.
- [Validation record](validation.md): observed internal-writer contamination and
  limits of the subsequent prompt correction.
