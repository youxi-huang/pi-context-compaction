# Preview experience plan

This plan makes the independent preview quiet in ordinary work and specific when it has to stop. It changes what the user reads and where state is shown. It does not change what the preview checks, when it blocks or what it stores. It is not a release plan: version strings, build identities, tags and publication stay with the maintainer, and nothing here waits on a version number.

The scope is the preview: `packages/coding-agent/src/extensions/context-memory/preview/`, its tests, the preview scripts that match its text, and the documents that quote it. The top-level files of `context-memory/` feed the resident fingerprint and stay as they are, so neither [deliberate gate](operations.md#two-deliberate-gates) should be reached.

## What a user sees today

Read from the source at `e020cda` and from official Pi 1.3.0.

- Each session start shows a three-sentence notice with a build hash (`readyNotice` in `notices.ts`). The hash helps a bug report, not a user starting work.
- Between notices nothing shows the preview's state. A paused session is discovered by sending input and being refused.
- A failure notice opens with its code (`context-memory preview: CONTEXT_NOTE_QUOTE. ...`) and runs to four sentences. A blocked session repeats the whole text on every input, because each input starts a new notice episode in `NoticeGate`.
- When the extension refuses a manual `/compact`, stock Pi also prints `Compaction cancelled`. The extension cannot change that line, so its own notice must say plainly that no checkpoint was saved.
- The doctor's `manual /compact` line carries a sentence of about 60 words on Pi's history gate, and its `durable block` label is internal vocabulary.
- Notices say `context-memory preview`, the commands say `compaction`, the README says Pi Context Compaction.
- 25 of the project codes have no advice in `notices.ts`. Raised on a preview path, any of them would reach the user as "The preview could not confirm that it is safe to continue." Which ones a preview path can raise has not been traced.

## Principles

1. Quiet when it works, specific when it does not.
2. State has one place, the footer. A notice is for an event the user may need to act on.
3. The outcome comes first. The code comes last, for reports and searches.
4. No new settings. A behavior that needs a switch is not ready.
5. Every guarantee stays: a failed compaction blocks, no writer is substituted, every check runs as before.

## Decisions

| | Choice | Rejected, and why |
| --- | --- | --- |
| D1 | Notices begin with `Source-linked compaction`, kept in one constant. Stored identifiers such as `context-memory` and `pi-context-memory.json` keep their names. | `context-memory preview` is an internal identifier. `Context compaction` also names Pi's own compactor, so "off in this session, Pi's own compaction applies" would read as a contradiction. |
| D2 | The footer carries state through `ctx.ui.setStatus("context-memory", text)`, with the texts in U1. Without a UI nothing is set. | A widget or a custom footer adds surface and displaces other extensions. A setting to hide the status breaks principle 4. |
| D3 | The ready notice drops the build hash and the overflow clause. | The doctor already shows the build, and an overflow failure explains `/compact` when it happens. |
| D4 | After the full notice for a durable block, later blocked inputs in the same session get one short line, until the block clears or the code changes. | A full notice on every input is noise. No notice would refuse input in silence. |
| D5 | Unchanged: `/compaction-status` JSON, tool descriptions and prompt guidelines, writer prompts, note rendering, and error text returned to the model. | Models, scripts and the evaluation read these, not a person scanning a notice. |
| D6 | Timing is measured before anything is optimized (U3). | Optimizing on intuition near the trust boundaries. |

`setStatus(key, text)` has the same declaration on official Pi 1.3.0, 1.2.0 and 1.1.0. The interactive footer joins extension statuses on one line, sorted by key and truncated to the terminal width, so each text stays short.

## Work packages

U1 and U2 share only tests, documents and `CHANGELOG.md`, and can run in parallel. U3 changes no runtime code.

### U1 Footer state

Show what the preview is doing without a notice.

| State | Footer text |
| --- | --- |
| Ready, no preview checkpoint on the current branch | `compaction: on` |
| Ready, N preview checkpoints on the current branch | `compaction: 1 checkpoint`, `compaction: N checkpoints` |
| From compaction start to its commit or failure | `compaction: writing note` |
| Paused: a pending or blocked attempt, or a failure held in memory | `compaction: paused, see /compaction-doctor` |
| Standing aside, `enabled: false`, or no UI | nothing; clear any earlier text |

- Put the texts and one guarded setter, shaped like `notify()`, in a new `preview/status-line.ts`. A failing `setStatus` never affects compaction, recovery or a request.
- Set the text where the controller already decides the state: session start, stand-aside, compaction start, `fail()`, commit, `/compaction-recover`, a failed compaction and a branch change. Derive it from values in hand at that point. Do not call `diagnose()` or `status()`, read the disk, start timers, or add work to a request that passes. A block that stops a single request leaves the footer alone.
- Tests in `test/context-memory-preview.test.ts`: the sequence for a fresh session, a commit, a refused note, a recovery and a stand-aside; nothing set without a UI; a throwing `setStatus` leaves the compaction result unchanged.
- Documents: one sentence in the README's first-session section and one in the preview guide's first-use section. One `Added` line in `CHANGELOG.md`.
- Size: about 120 lines of runtime code.

### U2 One voice

Rewrite every user-facing line in `notices.ts`, and in `extension.ts` the recover confirmation, the writer warning at session start and the three command descriptions, to these rules:

- Shape: `<prefix>: <outcome>. <cause>. <what happens to requests>. <next step>. (<CODE>)`, in two to four short sentences.
- Outcomes use the user's words: `checkpoint not saved`, `requests paused`, `off in this session`.
- A durable block says it once: `Requests stay paused, through /reload and restarts, until a checkpoint is saved.` Where `/compact` cannot clear it: `Requests stay paused in this session.` A block on one request: `Only this request was stopped.`
- One next step and at most one alternative, with commands named exactly.
- Internal words stay out: marker, staged, durable, latch, episode. Keep the guides' vocabulary: checkpoint, note, session, requests, protected.
- Present tense, second person, contractions allowed. No "please", "successfully", apologies or exclamation marks. No em dashes, and no chains of semicolons.

| Today | Target |
| --- | --- |
| `context-memory preview is active (stock-preview+src.<hash>). It compacts on /compact and at Pi's threshold after completed turns; context-overflow recovery needs /compact. Run /compaction-doctor to check this session.` | `Source-linked compaction is on. It writes a checkpoint on /compact and when the context nears its limit. /compaction-doctor checks this session.` |
| `context-memory preview: CONTEXT_NOTE_QUOTE. A quotation in the handover note does not appear in the entry it cites, so no checkpoint was saved. Requests in this session are paused; new input, /reload and restarting Pi do not clear this. Next: run /compact to try again.` | `Source-linked compaction: checkpoint not saved. A quotation in the note doesn't match the message it cites. Requests stay paused, through /reload and restarts, until a checkpoint is saved. Run /compact to try again. (CONTEXT_NOTE_QUOTE)` |
| The same code at the next blocked input | `Source-linked compaction: requests are still paused. Run /compact to try again. (CONTEXT_NOTE_QUOTE)` |
| `context-memory preview is not active in this session: this session contains an image, and the preview supports text-only sessions. It has not changed this session, and Pi's own compaction applies here. Start a new text-only session to use source-linked compaction.` | `Source-linked compaction is off in this session because it contains an image. Pi's own compaction applies, and nothing was changed. Start a new text-only session to use it.` |
| `context-memory preview: the staged checkpoint and its original sources were confirmed on disk.` | `Source-linked compaction: checkpoint confirmed on disk. Requests resume.` |

- The short repeat (D4) extends `NoticeGate`: per session, remember the code whose full notice was shown, and forget it when a checkpoint or a recovery is confirmed. One notice per input remains the rule.
- The doctor keeps the `label: result - detail` form that acceptance and the scenarios read. `durable block` becomes `requests`, reading `ok - not paused` or `paused - ...`; the other labels stay. Shorten the details, and state Pi's history gate in one line at most, only where `manual /compact` reads `unknown` or `retry`.
- Trace which `PROJECT_CODES` a preview path can bring to a notice, the doctor or a recover refusal. Give each reachable code its own advice and a test that it does not reach the fallback text. List the unreachable codes in the PR description, one line of evidence each, and add nothing for them.
- Update the strings that the scenarios, acceptance, writer bench and A/B runner match, keeping what each check means. Change the README and the preview guide only where they quote a changed line. One `Changed` line in `CHANGELOG.md`.
- The PR description carries a before/after table of every changed line, so the copy can be reviewed without reading code.
- Size: mostly strings; `NoticeGate` grows by about 15 lines.

### U3 Where the time goes

Answer three questions on official Pi 1.3.0 with scripted providers, offline:

1. How long does reopening a session take at 1, 10 and 40 checkpoints, against the disabled control?
2. Of a compaction's pause, how much is the extension's own work outside the writer call: staging, validation and disk readback?
3. Which functions dominate those times? Profile `scripts/context-memory-preview-scenarios.mjs --only long-session-overhead --perf-checkpoints 40` with `node --cpu-prof`.

The only changes allowed are `observe()` rows inside the existing `long-session-overhead` case and one entry at the top of `validation.md`, with commands, numbers, exit codes and the hot spots by file and line. No new checks, gates, scripts, runtime changes or `CHANGELOG.md` line. The entry ends with proposals, each marked preview-only or fingerprinted file, and whether it touches a check at a trust boundary. The maintainer chooses among them later.

## Not accepted

The review removes these, whatever the intent:

- New settings, environment variables, command arguments or flags.
- New error codes, failure states, marker fields or files on disk.
- Defense beyond the existing pattern of one guard at the UI boundary: no retries, timers, caches or fallbacks.
- Changes to anything in D5, to top-level `context-memory/*.ts`, to `eval/`, or to upstream Pi files.
- Version strings, build identities, the host list in `compatibility.ts`, the version in `context-memory-preview-build.mjs`, `CHANGELOG.md` headings other than **Unreleased**, tags and release assets.
- New scripts, helpers used once, snapshot files, and refactors or renames the change does not need.
- Comments that restate the code, and document text beyond the sentences a change makes false.

## Verification

Each package, before its PR:

```sh
node scripts/context-memory-ops.mjs verify
git diff --exit-code -- packages/coding-agent/src/extensions/context-memory/build.ts
node scripts/context-memory-ops.mjs preview   # after committing: its release step needs a clean checkout
```

Report each command with its result and exit code, as the [runbook](operations.md#evidence) asks, and mark a check that did not run `not run`. A diff in `build.ts` means a file outside `preview/` changed: stop and report it rather than commit the new fingerprint.

## Status

| Package | State |
| --- | --- |
| U1 Footer state | Done in #58 |
| U2 One voice | Done in #60 |
| U3 Where the time goes | Measured in #59. Its [proposals](validation.md#preview-reopen-and-compaction-overhead-on-official-pi-130-2026-10-18-utc) wait for the maintainer |
