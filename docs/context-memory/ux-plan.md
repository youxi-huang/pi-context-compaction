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

## Second batch

U3 showed where the extension's own time goes ([validation](validation.md#preview-reopen-and-compaction-overhead-on-official-pi-130-2026-10-18-utc)). V1 shortens those waits without changing what is compared. V2 looks at Pi's interactive terminal, which no check has covered yet. Both start from `main` and open their PRs against `main`, so CI runs on each; the review reads the diff and the CI result.

The third U3 proposal, batching in `identity.ts`, waits. It would reach both gates, and V1 can remove most of the repeated hashing without it.

### V1 Shorter pause, faster reopen

At 40 checkpoints, cut by at least a third both the extension's work around a compaction (674 ms) and its share of a reopen (135 ms). If that needs any comparison below to go, stop and report: time never buys a check.

The method is to produce the same bytes fewer times. A hash or a disk read may be shared only between uses inside one synchronous stretch, with no `await`, write or Pi append between them, and nothing outlives the call that computed it.

These comparisons stay, at the same moments:

| Where | Comparison |
| --- | --- |
| Readiness, `evaluate` in `failure-store.ts` | The disk branch at the leaf matches the in-memory branch |
| `begin` | The attempt's source hash comes from the branch and matches the disk branch at the leaf |
| `compact`, before the writer | The cloned branch matches the attempt's source hash |
| `compact`, after the writer | The same session and leaf, and the current branch matches the snapshot |
| `stage` | The current branch and the disk branch at the leaf match the attempt's source hash |
| Commit and recovery confirmation | The entry on disk equals the committed one, its sources match the marker's hash, and the in-memory branch matches the disk branch |
| Session start | Full checkpoint validation in `assertPreviewSession`, and the readiness readback |

Candidates from the profile:

- `begin` and the readiness check inside it share one fresh read of the session file.
- After the writer, `compact` compares the current branch with `attempt.sourceHash` instead of hashing its clone again, once a test shows the clone is never changed.
- At session start, the readiness readback and checkpoint validation serialize the same branch once between them.

Beyond Not accepted: no file outside `preview/` changes, `identity.ts` included. No cache is keyed by entry objects, because an entry changed in place must still be found. Hashes stay byte-identical, so existing checkpoints open unchanged. Each shared read or hash gets a focused regression showing that a change inside the window it covered is still refused, and the acceptance cases `memory-change`, `disk-change`, `checkpoint-write-failed` and `unobserved-commit` pass unchanged.

Evidence: a new `validation.md` entry with before and after side by side, from the same machine and the U3 commands, two runs of each at 1, 10 and 40 checkpoints, and one profile at 40. The PR description names each repetition removed, by file and line.

### V2 What the terminal shows

Read only. Run official Pi 1.3.0 interactively in a pseudo-terminal, for example `script` driven through `@xterm/headless` from the repository's dependencies. Use the acceptance runner's isolated agent directory, loopback provider and scripted responses. Capture the screen as text at 120 and 80 columns after each step:

1. A fresh session starts: the ready notice and the footer.
2. `/compaction-doctor`.
3. A `/compact` whose note fails its quotation check: the notice, Pi's own `Compaction cancelled`, the footer.
4. The next input: the short repeat.
5. A successful `/compact`: the footer count and the summary Pi renders.
6. A session the preview leaves to Pi, such as one with a checkpoint from Pi's own compaction.

The deliverable is one `validation.md` entry with the screens, every path replaced by `<cwd>`, and a list of what reads wrong, wraps badly, is cut off or appears twice. Findings, not fixes. The driver goes in the PR description, not the repository, and no runtime, test or script file changes.

## Third batch

V2's [terminal entry](validation.md#preview-interactive-terminal-on-official-pi-130-2026-10-18-utc) found what no synthetic check had: Pi's own errors after the preview's notices, and a notice that never shows. Like the second batch, these packages start from `main` and open their PRs against `main`.

### X1 Hold input while paused

Chosen by the maintainer on 2026-10-18 over keeping today's path. In a paused session, an interactive input that Pi would send as a prompt stops at Pi's `input` event, before any request. The preview shows the notice it shows today (the short repeat, or the full notice for a new code), returns `{ action: "handled" }`, and puts the typed text back in the editor with `ctx.ui.setEditorText`. Nothing typed is lost, no request starts, Pi prints no `This operation was aborted`, and the input is not recorded in the session.

- Paused means what the footer calls paused: a failure the controller already holds in memory for this session. The handler reads no disk and calls neither `diagnose()` nor `status()`.
- Only `source: "interactive"` with a UI, and only text. Input with images, RPC and print mode, input an extension sends, and a session that is not paused keep today's path.
- Pi runs extension commands, `/compaction-*` included, before the `input` event, and `/compact` is Pi's own command, so neither reaches the handler. Confirm both on official Pi 1.3.0, 1.2.0 and 1.1.0.
- The request guard does not change and stays the backstop: a request that still reaches it in a paused session is stopped as before. One notice per input stays the rule.
- Regressions in `test/context-memory-preview.test.ts`: a paused interactive input is handled and its text restored; a session that is not paused, a non-interactive source and an input with images continue; the request guard still stops a request in a paused session.
- Documents: the README's recovery section and the preview guide's failure section say that input typed while paused stays in the editor. One `Changed` line in `CHANGELOG.md`.
- Evidence: steps 4 and 5 of the V2 driver at 80 columns, before and after, in the PR description, and CI green.

### X2 The off notice on reopen

Reopening a session with a checkpoint from Pi's own compaction shows no `Source-linked compaction is off in this session`, although `/compaction-doctor` reports the session inactive (step 6 of the terminal entry). Find why on official Pi 1.3.0, 1.2.0 and 1.1.0 with the V2 driver from PR #61, and check whether the same cause hides the ready notice when a protected session reopens.

Fix it only if the existing notice can then appear once per session and process through the existing `notify()`, with no new setting, command, file or footer text. Showing it at a later event Pi already sends is acceptable. If no such fix exists, report the cause and stop. Evidence: the 80-column step 6 screen before and after in the PR description, a focused regression in `test/context-memory-preview.test.ts`, and CI green.

## Fourth batch

The last round adds no behavior. Y1 puts on screen what #66 proved only in unit tests. Y2 walks a new user's whole path and smooths the words on it. Both start from `main`, open their PRs against `main`, and can run in parallel. Each adds one entry at the top of `validation.md`; the merge resolves that.

The evaluation test that failed once on #64 (`eval/live/live.test.ts:666`) passed on #66 and is not scheduled. If it fails on Y1 or Y2, report the run and leave `eval/` alone.

### Y1 Evidence for the review fixes

#66 changed two behaviors of X1 and kept one of X2, each covered only by unit tests. Show them on official Pi 1.3.0, 1.2.0 and 1.1.0 at 80 columns, with the V2 driver from PR #61 as #64 and #65 adapted it:

1. **A paused session whose branch ends at a checkpoint, with nothing staged.** `/compact` gets Pi's own `Already compacted`. A short text input is recorded and stopped by the request guard, not held in the editor. The next `/compact` writes a checkpoint and requests resume. This is the path the preview guide describes after `Already compacted`. Build the state with fixtures the acceptance and scenario scripts already use; if none reaches it on a real host, say so for this step.
2. **Messages typed during a failing `/compact`.** While a `/compact` whose note fails is running, type two messages. Pi queues them; after the failure both are in the editor, in the order typed, under one notice. Nothing is recorded and no request starts.
3. **The ready notice once per process.** After `/new` in the same process, no second ready notice. Reopening a session with Pi's own checkpoint still shows the off notice at the first input.

The deliverable is one `validation.md` entry of at most 120 lines: the 1.3.0 screens for each step, every path replaced by `<cwd>`, and one row per step and version with the result. The driver goes in the PR description, not the repository. No runtime, test or script file changes. If a step does not behave as described here or in the guide, stop at that step and report its screen.

### Y2 One pass, start to finish

On official Pi 1.3.0, 1.2.0 and 1.1.0 at 80 columns, walk the path a new user takes, with the same driver:

1. Install the built package into a clean agent directory as the README says, and start Pi.
2. A fresh session: the ready notice and the footer.
3. `/compaction-doctor`.
4. `/compact` before there is enough history.
5. Work until `/compact` can run, then a successful `/compact`.
6. A `/compact` whose note fails its quotation check.
7. Text typed while paused.
8. A successful `/compact`, and the next request.
9. `/reload`; then quit, reopen the session and send one input.
10. A session with a checkpoint from Pi's own compaction, and its first input.
11. `/new`.

List every rough edge you see: a line that reads wrong, wraps badly at 80 columns, is cut off, repeats, or contradicts another line. Give each its version, step and screen excerpt, and mark it fixed here or left for the maintainer, with the reason.

Only words may change: the user-facing strings in `preview/notices.ts`, `preview/extension.ts` and `preview/status-line.ts`, the test, scenario and acceptance lines that quote them, and the document sentences that quote them. Each change keeps D1's prefix, the outcome first and the code last, and footer texts stay short. When and whether a notice appears, every check, Pi's own lines and anything listed in D5 stay as they are; report those instead. At most ten wording changes; list any further ones for the maintainer. One `Changed` line in `CHANGELOG.md` if any wording changes.

Evidence: each changed line before and after, on 1.3.0, in the PR description; one `validation.md` entry of at most 150 lines with the 1.3.0 walk trimmed to the lines that matter and one row per step and version; CI green.

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
| U3 Where the time goes | Measured in #59; V1 takes up two of its proposals. The third, batching in `identity.ts`, is set aside by the maintainer: it crosses both gates for tens of milliseconds |
| V1 Shorter pause, faster reopen | Done in #62: 44% less work around the writer and 37% less added to a reopen at 40 checkpoints |
| V2 What the terminal shows | Done in #61 |
| X1 Hold input while paused | Done in #65: paused text returns to the editor. #66's checkpoint-leaf exception was removed after Y1 showed that path never ran |
| X2 The off notice on reopen | Done in #64: Pi's `Session compacted` status rewrote the notice; it now appears with the first input |
| Y1 Evidence for the review fixes | Done in #68, steps 2 and 3 completed in review |
| Y2 One pass, start to finish | Done in #69: two doctor strings reworded; the other rough edges are Pi's own |
