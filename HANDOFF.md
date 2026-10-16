---
branch: claude/busy-gates-o71sr0
pr: none
head: 7df8c04
written: 2026-10-16, Claude Code, cloud
---

# Handoff: Pi 1.3.0 support and its bounded provider run, ready for a PR

## Goal and done-when

The branch adds Pi 1.3.0 support to the preview and records one bounded real-provider trial. The trial is done. What remains is a PR to `main`, opened only when the user asks, with CI and CodeQL green.

## State

- [verified] Pi 1.3.0 support, doctor recovery states and host-driven release tooling: commits `2587da3`, `11bdae6`; checks in the second entry of `docs/context-memory/validation.md`; changes under Unreleased in `CHANGELOG.md`.
- [verified] `node scripts/context-memory-preview-build.mjs`, exit 0, at `06f1f0e`: build `stock-preview+src.6d21d37d4e59aefe`, the same candidate validated at `11bdae6`.
- [verified] `node scripts/context-memory-preview-stock-install.mjs --version 1.3.0`, exit 0, network-blocked SDK import passed.
- [verified] Provider run on official Pi 1.3.0 with `deepseek/deepseek-flash`, 51 requests in 6 min 15 s: first `/compact` failed with `CONTEXT_NOTE_QUOTE`, its retry and the second `/compact` committed, checks 5/5 and 9/9. Full record in the top entry of `docs/context-memory/validation.md`, commit `7df8c04`.
- [verified] `opencode/deepseek-v4.1-flash-free` returns HTTP 403 `FreeTierError` to Pi and to plain `curl` on `/inference/v1` and `/inference/openai/v1`.
- [not run] `context-memory-ops.mjs verify` and `preview` after `11bdae6`; only documentation changed since. GitHub CI and CodeQL for this branch.

## Decisions

- Model: the user switched to their own DeepSeek key, injected by the proxy for `api.deepseek.com`, after the OpenCode free tier refused non-OpenCode clients. Rejected: imitating the OpenCode client, because it bypasses the provider's access control and would not speak for Pi users.
- Budget: 60 model requests and 45 minutes, confirmed by the user before the first DeepSeek request; the three refused OpenCode requests are counted separately. Writer calls are not RPC message events, so the count adds them from `/compaction-status` `calls`.
- The failed first compaction was retried once with `/compact`, the documented recovery, and recorded as it occurred.
- The model's `bash` tool was excluded; long tool outputs came from paged `read` calls.
- Left unchanged on purpose: the statements in `roadmap.md` and `extension-preview.md` that real-provider behavior remains unproven or outstanding. One bounded run does not settle them; the maintainer decides.
- Package version stays 0.4.2; the bump, changelog section and tags are the maintainer's.

## Read first

`AGENTS.md`; the top two entries of `docs/context-memory/validation.md`; `CHANGELOG.md` Unreleased; the Finishing section of `docs/context-memory/handoff-protocol.md`.

## Settled

- Whether the OpenCode free model can serve this trial: no, recorded in the top entry of `validation.md`.
- `/compaction-status` cross-session leak and release-list edits: as in the previous handoff, recorded in CHANGELOG Unreleased.

## Next steps

1. When the user asks, open a PR from `claude/busy-gates-o71sr0` to `main`. Delete `HANDOFF.md` in its last commit and move the Previous handoff check below into the PR description.
2. Drive CI and CodeQL on the PR to green.

## Previous handoff check

- Missing: Next steps put a probe request before the budget confirmation that Decisions required before the first request; the budget was confirmed first. The budget count did not say that writer calls fall outside RPC message events.
- Repeated: none
- Wrong: the plan assumed the free OpenCode model accepts Pi's requests; it refuses every non-OpenCode client with 403 `FreeTierError`, not the anticipated 401.
- Unused: `extension-preview.md` section Before updating Pi.
