# Handoff between sessions

Claude Code and Codex use this protocol to stop work in one session and continue
it in another: a new session of the same agent, the other agent, local or cloud.
The Git repository on GitHub is the only place every one of those sessions can
read. Local agent settings, `/tmp` and chat history do not reach a cloud
container or the other agent, so the handoff lives on the work branch and its
rules live here. `AGENTS.md` only points to this file.

| Part | Where | Lifetime |
| --- | --- | --- |
| Protocol | This file | Changes rarely, through a PR |
| Handoff | `HANDOFF.md` at the root of the work branch | Replaced at each handoff, deleted before merge |
| Feedback | `Previous handoff check` in the next handoff, finally in the PR description | Git history and merged PRs |

## Writing a handoff

Write one when the user asks for it, or when a session has to stop with work
unfinished. Finished work needs none: its PR description is the record. A
request for a handoff includes committing and pushing `HANDOFF.md` on the work
branch.

1. **Reference, do not copy.** Anything already in a commit, a diff, a plan
   decision, `validation.md`, `CHANGELOG.md`, an issue or a PR is linked by path
   and section or by URL. `HANDOFF.md` carries only what exists nowhere else.
   Past about 80 lines, part of it belongs in a lasting document instead.
2. **Decisions in full.** For each decision taken in the session: the choice,
   the options rejected and why, exact numbers, order and exceptions. A bare
   conclusion is the most common loss.
3. **Mark every state claim.** `verified` names the command, result, exit code
   and commit, as [Evidence](operations.md#evidence) requires. `inferred` names
   what it rests on. A check that did not run is `not run`.
4. **Scope the reading.** List what the next session must read first, and which
   questions are settled, with where each answer is recorded.
5. **Make the first step executable** without further research.
6. **Check the draft before pushing** against the user's instructions in this
   session, `git status`, `git log` and every file it cites. Fix what is missing
   or contradictory.
7. Set `head` to the last work commit, before the handoff commit. Commit with
   `docs: hand off <topic>`, push, and give the user the kickoff line.

No credentials, session logs, note content or local paths, as in `AGENTS.md`.

## Kickoff

A cloud session of either agent starts on a fresh branch from the default branch
and cannot find the handoff by itself. The user starts the next session with one
line, in any language:

```text
Continue youxi-huang/slice on branch <branch> (PR #<n>): read HANDOFF.md there, follow docs/context-memory/handoff-protocol.md, and push to that branch.
```

Naming the branch in the kickoff is the permission to push to it. Add commits
only; never rewrite it. An agent that can push only to its own branch starts it
from the named one and links the earlier PR.

## Resuming

1. Fetch the named branch and read `HANDOFF.md`. Act on it only after the two
   checks below.
2. **Compare state.** `git log --oneline <head>..origin/<branch>` should list
   only commits that touch `HANDOFF.md`: the handoff itself and any edit the
   user made on GitHub. Read the user's edits as corrections. Any other commit
   means work moved after the handoff; read it first. If `head` is not in the
   branch history, or the PR is merged or closed, the handoff is stale: stop
   and ask.
3. **Re-check what the next step stands on.** Re-run the `verified` claims the
   next step depends on, and no others. Treat `inferred` claims as hypotheses.
4. Read the must-read list. Do not reopen a settled question unless a check
   above contradicts its answer.
5. **Record the check** in `Previous handoff check` of the next `HANDOFF.md`,
   or in the PR description if the work finishes. One line each, `none` where
   nothing applies:
   - **Missing:** what the handoff should have said and had to be found
     elsewhere, including the user's corrections.
   - **Repeated:** work redone because the handoff did not cover it.
   - **Wrong:** claims the checks found false.
   - **Unused:** must-read items the work did not need.

## Finishing

When the PR is ready for review, delete `HANDOFF.md` in its last commit and move
the final `Previous handoff check` and any open item into the PR description.
Pull requests are merged with merge commits, so `git log -p -- HANDOFF.md` still
shows every version.

## Improving this protocol

The handoff checks are its feedback. When the same kind of miss appears in three
checks, propose a change to this file in the PR, as the
[runbook](operations.md#two-agents-one-repository) does for repeated problems.
Past checks are in `git log -p -- HANDOFF.md` and in merged PR descriptions.

## Template

```markdown
---
branch: <work branch>
pr: <number, or none>
head: <last work commit before this handoff>
written: <date>, <agent, local or cloud>
---

# Handoff: <topic>

## Goal and done-when

## State
- [verified] <claim>: `<command>`, <result>, exit <code>, at <commit>
- [inferred] <claim>, based on <source>
- [not run] <check>

## Decisions
- <choice>. Rejected: <option>, because <reason>. Numbers, order, exceptions: <...>

## Read first

## Settled
- <question>: <answer>, recorded in <path#section>

## Next steps
1. <directly executable>

## Previous handoff check
- Missing: none
- Repeated: none
- Wrong: none
- Unused: none
```
