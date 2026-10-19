# Preview cost plan

The [experience plan](ux-plan.md) made the preview quiet. This plan looks for what the preview still spends without buying a guarantee: tokens it adds to every request, and money it stops Pi from saving. It removes nothing a check at a trust boundary needs and changes no stored format. Its scope is the experience plan's: `preview/`, its tests, the preview scripts that quote it and the documents that describe it, so neither [deliberate gate](operations.md#two-deliberate-gates) should be reached.

## Where the cost is

Read from the source at `86cb9c6` and from the records it cites.

- The extension's own processing is no longer the cost. A request carries 1 ms of it at 40 checkpoints ([U3](validation.md#preview-reopen-and-compaction-overhead-on-official-pi-130-2026-10-18-utc)), and V1 cut the work around a compaction by 44% ([V1](validation.md#preview-pause-and-reopen-after-sharing-reads-and-hashes-official-pi-130-2026-10-18-utc)). More work on hashing would save milliseconds.
- The pause is the writer call, a median of 12 to 14 s in the v0.5.0 bench. Taking it out of the pause is [0.8.0](roadmap.md#planned-minor-releases)'s work.
- Every request carries the declarations of `context_note` and `context_history`. `context_note` is registered in every session, with arm B on or off; only its prompt guideline follows B (`preview/extension.ts:158`). Its schema repeats the fact object in five sections. Neither declaration has been measured.
- In every session it guards, the preview answers Pi's `cache_warming_decision` with `stop` (`preview/extension.ts:110`), because a refresh replays the last request outside the request hooks ([contract](extension-preview-contract.md)). That overrides the user's `cacheWarming` setting in all of those sessions, not only in paused ones. Pi refreshes only when it expects to save at least $0.05 (`core/cache-warmer.ts` in the 1.1.0 snapshot). In the snapshot's model generator only direct Anthropic models declare a cache lifetime, and OpenAI lifetimes are left out on purpose (`packages/ai/scripts/generate-models.ts:982`). The gain from Z2 is therefore narrow: direct Anthropic models, and tool calls that run longer than about 90% of the cache lifetime.

## Settled

An external review of 2026-10-18 proposed further cuts. These are decided and are not reopened in this batch.

| Proposal | Decision |
| --- | --- |
| Merge arms A and B now | No. By the maintainer's decision of 2026-10-17, B becomes a hint for 0.8.0's segments and keeps its path until then ([roadmap](roadmap.md#planned-minor-releases)). |
| Cache `listHistory` per branch snapshot | No. Caches are [not accepted](ux-plan.md#not-accepted). Z1 measures one list call. |
| Skip `workNotes()` when B is off | No. With B off the scan still passes voluntary notes to the synchronous writer (`compact` in `preview/controller.ts`), and without notes it is one type test per entry. Z1 measures it. |
| Read `pi-context-memory.json` once | No. It is read twice per process, and the two reads fail differently on purpose: invalid core settings block requests, an invalid arm switch turns off only that arm. Merging them would change `config.ts`, which the resident fingerprint covers. |
| Mark `eventLog`, `compactAt` and Pi's `keepRecentTokens` | Already stated in [Settings](configuration.md#settings) and [When `/compact` can run](configuration.md#when-compact-can-run). |
| Canonical source hashes | Unassigned in the [roadmap](roadmap.md#planned-minor-releases); it needs a compatibility plan for stored checkpoints. |
| A lower effort for the session writer | No. Under 0.8.0's decisions the synchronous writer keeps the session's thinking level. |

## Work packages

Run Z1, then Z2, in one session. Each is its own commit, so the review can keep or drop either.

### Z1 What each request carries

Answer on official Pi 1.3.0, offline, with the acceptance runner's isolation and a scripted loopback provider:

1. The tokens the preview adds to every request: the declarations of `context_note` and `context_history` and their prompt guidelines, measured as bytes of the `before_provider_request` payload with and without each, with arm B off and on, and converted with Pi's estimate.
2. The tokens a checkpoint adds to every later request: the rendered summary at 1, 10 and 40 checkpoints of `long-session-overhead`, split into fixed text (headings, lineage, guidance) and the note's facts.
3. How often a model called `context_note` without arm B in the provider runs `validation.md` already records, and how many of those calls were refused. No new provider run.
4. Numbers for two settled rows: one `listHistory` call, and one `workNotes()` scan with no notes and with 20, each at 40 checkpoints.

The deliverable is one `validation.md` entry of at most 100 lines with commands, numbers and exit codes, and the driver in the PR description. No runtime, test or script file changes. The entry ends with proposals, each with what it saves per request and what it costs. One of them answers whether `context_note` should be registered only with arm B: the saving from (1), the notes from (3) the writer would lose, and what a session whose history already holds `context_note` calls sends once the tool is gone. The maintainer decides; this batch implements none of them.

### Z2 Cache warming while a turn runs

In a session the preview guards, Pi's own warming decision applies while an agent run is active. The preview stops a refresh only where one could cross a check.

The hazard: each refresh appends a `cache_warm` usage entry to the session. One that lands between `begin` and the confirmation of a commit changes the branch under the attempt, the compaction fails with `CONTEXT_SOURCE_CHANGED`, and requests pause. A paused session is not warmed either.

What the 1.1.0 snapshot suggests, to be confirmed on official 1.3.0, 1.2.0 and 1.1.0 before any code changes:

- Every real request restarts the warming run and aborts a refresh in flight (`CacheWarmer.start`, called from `core/sdk.ts`).
- When the agent settles, a `streaming` run stops and a refresh in flight is aborted before it can append (`onAgentSettled`, `clearRun`, `validateRun`). An `idle` run continues, so a refresh can still be in flight when `/compact` begins.
- A refresh is appended only while the conversation is unchanged (`validateRun` before `appendUsage`).

The rule, if those hold: the handler returns no result, so Pi decides, when an agent run is active in this session, no compaction is active or staged, and no failure is held for the session. Otherwise it returns `stop`, as today. The run state is tracked in memory from Pi's run events. The handler reads no disk and calls neither `diagnose()` nor `status()`. Sessions the preview stands aside from keep Pi's decision. An `idle` setting therefore warms while a turn runs and stops when it settles.

Stop and report, with no runtime change, if on any of the three hosts a refresh can append inside the window above, a branch holding `cache_warm` entries changes the result of a compaction, a reopen, `/compaction-doctor` or `context_history`, or a refresh after a commit replays the pre-checkpoint request.

If the rule stands:

- About 20 lines in `preview/extension.ts` and `preview/controller.ts`.
- Regressions in `test/context-memory-preview.test.ts`: Pi's decision during an active run in a ready session; `stop` after the run settles, during a compaction, with a staged attempt and in a paused session; a session the preview stands aside from unchanged; a `cache_warm` entry before `/compact`, then a commit that confirms.
- Acceptance: the loop at `scripts/context-memory-preview-acceptance.mjs:183`, which expects `stop` for every decision, expects Pi's decision during an active run and `stop` otherwise. The case after a failed compaction (`:293`) stays as it is.
- Documents: the contract's warming line, the preview guide where it mentions warming, and one `Changed` line in `CHANGELOG.md`.
- Evidence in the PR description, on 1.3.0: during a long scripted tool call a refresh reaches the loopback provider and its entry is in the session; the next `/compact` commits; after a failed compaction no refresh is sent. Also which catalog models on each host declare a cache lifetime, which says who gains.

## Not accepted

Everything on the [experience plan's list](ux-plan.md#not-accepted), and:

- Changes to source hashes, checkpoint validation, disk readback, the failure marker, writer prompts, note rendering, arm A or arm B.
- A setting or flag for warming. The user's `cacheWarming` stays Pi's.
- Implementing a Z1 proposal in this batch.

## Verification

As in the [experience plan](ux-plan.md#verification), for each package.

## Status

| Package | State |
| --- | --- |
| Z1 What each request carries | Measured in `5c298e6`: [results and proposals](validation.md#z1-preview-request-and-checkpoint-cost-official-pi-130-2026-10-18-pdt). The proposals wait for the maintainer. |
| Z2 Cache warming while a turn runs | Stopped at its first condition in `984885a`. The warming guard stays. |

### Z2 stop

Official Pi 1.3.0, 1.2.0 and 1.1.0 ship the same `cache-warmer.js`. On each, a refresh sent while a run is active survives the end of the run in `idle` mode: `onAgentSettled` aborts it only in `streaming` mode, and `validateRun` checks the conversation prefix, which a compaction leaves unchanged while its writer waits. Released after `/compact` began, the refresh appended `cache_warm` between `begin` and staging, and the compaction failed with `CONTEXT_SOURCE_CHANGED` and a durable marker. A `stop` at the next decision comes too late for a refresh already sent. In `streaming` mode the refresh was aborted when the run settled, and the checkpoint committed.

The probe replaced only the loaded handler, in memory, and is synthetic: an 11-second cache lifetime on a loopback provider, not Anthropic's cache or billing. Its driver, its timeline and the 17 direct Anthropic models that declare a cache lifetime on each host are in [PR #72](https://github.com/youxi-huang/pi-context-compaction/pull/72). The later probes were not run.

No runtime, test, script, contract or guide change follows. Warming only under Pi's `streaming` setting, or cancelling a refresh in flight, would each need a separate design decision; this batch adds neither a setting nor a host change.
