---
branch: claude/busy-gates-o71sr0
pr: none
head: 6fe5906
written: 2026-10-16, Claude Code, cloud
---

# Handoff: bounded live trial of the preview on Pi 1.3.0 with an OpenCode free model

## Goal and done-when

Run one bounded real-provider trial of this branch's preview on official Pi 1.3.0 with `opencode/deepseek-v4.1-flash-free`, and record it in `docs/context-memory/validation.md` as a provider run, kept apart from synthetic evidence. Done when one representative task has gone through two manual compactions with its continuation checks recorded, or the trial stopped at its budget or a failure that is recorded as it occurred. Then open a PR for the branch only if the user asks.

## State

- [verified] Pi 1.3.0 support, host-driven release tooling, doctor recovery states and per-session status: commits `2587da3`, `11bdae6`; documentation and results in the top entry of `docs/context-memory/validation.md` and under Unreleased in `CHANGELOG.md`.
- [verified] `node scripts/context-memory-ops.mjs verify`, exit 0, on the code committed as `2587da3`; resident fingerprint unchanged.
- [verified] `node scripts/context-memory-ops.mjs preview`, exit 0, at `11bdae6`: acceptance 32/28/28 on 1.3.0/1.2.0/1.1.0, strict scenarios 145 passed on 1.3.0, release `--prepare` passed.
- [verified] `node eval/check.mjs` with `PI_OFFLINE=1`, `EVAL_PROVIDER_MODE=scripted`, `EVAL_MODEL_CALL_BUDGET=0`: 89 passed, exit 0, at `11bdae6`.
- [verified] The session's network policy denied `opencode.ai` (CONNECT 403).
- [inferred] The user is adding the key as a Network secret of type Bearer for `opencode.ai`, path prefix `/inference/`, based on their settings screenshot in this session: the proxy adds `Authorization: Bearer <key>` to those requests, and the key never enters the container or `OPENCODE_API_KEY`. Whether it replaces a header Pi already sends is unknown.
- [inferred] Pi 1.3.0 reads `OPENCODE_API_KEY`; its catalog lists `deepseek-v4.1-flash-free` under provider `opencode` at `https://opencode.ai/inference/v1`, 200,000-token window, 32,000 max output, reasoning on, zero listed cost. Based on the 1.3.0 `pi-ai` package data.
- [not run] Any real-provider call; GitHub CI and CodeQL for this branch.

## Decisions

- The user authorized a live trial with their own OpenCode key and the free DeepSeek V4.1 Flash model. Budget not yet set: propose one task, two compactions, at most 60 model requests and 45 minutes, and confirm with the user before the first request.
- Compact manually. Pi's threshold sits at 183,616 tokens for this window (window minus 16,384), too far for a bounded trial; manual `/compact` needs about 31,000 estimated tokens of history first (Pi keeps 20,000 by default).
- Use the official Pi 1.3.0 host, not this repository's patched build, with the built package installed in an isolated agent directory, so the result speaks for stock Pi. The A/B runner's `--bridge` mode is the fallback if driving the CLI proves impractical.
- The key stays in the proxy. Pi sends no request without a configured key, so give only the Pi process `OPENCODE_API_KEY=proxy-injected` as a placeholder. Never try to read, print or log the real key, and keep session files and note text out of the repository; validation.md gets counts, codes, timings and pass or fail per probe.
- Package version stays 0.4.2. Bumping to 0.4.3, the changelog section and tags are the maintainer's.
- Not done on purpose: no optimization of the request scans (measured 4.7 ms p50 at 10,000 entries on 1.3.0), no change to `beforeRequest`'s string check (`context()` already checks the summary's position), no `hashEntries` change (roadmap, Source-hash follow-up).

## Read first

`AGENTS.md`; `docs/context-memory/operations.md` sections Evidence and Never; the top entry of `docs/context-memory/validation.md`; `docs/context-memory/extension-preview.md` sections Before updating Pi and Verification; the paragraph on further live work in `docs/context-memory/roadmap.md` (0.3.0 entry).

## Settled

- `/compaction-status` cross-session leak: unreachable in Pi's CLI, which runs the extension factory again for each session; fixed only for consistency. CHANGELOG Unreleased, Fixed.
- Whether a new release needs list edits: no; strict scenarios apply to every version after v0.4.0-preview.1. CHANGELOG Unreleased, Maintenance.

## Next steps

1. Check the route: `curl -sS -o /dev/null -w "%{http_code}\n" https://opencode.ai/inference/v1/models` must return an HTTP status, not a CONNECT 403; 200 means the injected key was accepted. Then confirm the proxy replaces Pi's own header: one tiny request through official Pi 1.3.0 with the placeholder key (the installed host's `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js -p` with `--model opencode/deepseek-v4.1-flash-free`) must succeed. A 401 means the placeholder reached OpenCode; then stop and ask the user to add the key as an environment variable instead.
2. Build and install: `node scripts/context-memory-preview-build.mjs`, then `node scripts/context-memory-preview-stock-install.mjs --stock-root <isolated dir> --version 1.3.0`.
3. Confirm the budget with the user, then run the task: an early constraint, a decision, a later correction, one long tool output and a stated next step; `/compact` after each half; record `/compaction-status` `lastCompaction` and `calls`, `/compaction-doctor` on any failure, and continuation answers.
4. Add a provider-run entry to validation.md, commit and push to this branch.

## Previous handoff check

- Missing: none
- Repeated: none
- Wrong: none
- Unused: none
