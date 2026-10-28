# Capacity profiles

On a route with a 200,000-token window and a 32,000-token output cap, Pi's
default trigger sits at 183,616 tokens and leaves room for only 16,384 tokens
of reply. This opt-in profile moves each host's native trigger to 150,000 and
keeps about 15,000 tokens of recent text. In Pi, optional Slice preparation
follows the new line by itself and starts at 131,250. The same arithmetic covers
128k and 1M windows; nothing is special-cased for 200k. The numbers are
starting values, not measured optima.

## Generate a profile

From a source checkout on Node 22.19 or newer:

```sh
node scripts/context-memory-pressure-profile.mjs \
  --context 200000 --output 32000 --input 200000 --model <provider>/<id>
```

Pass the provider's verified context window, its effective output reservation
(reasoning included where it counts) and a separate input limit only if the
provider declares one. A fallback value shown by a host is not evidence.
Invalid or contradictory limits are refused; plausible but wrong metadata
cannot be detected. The script prints JSON, writes nothing and calls no
provider.

With context C, output O and optional input limit I:

- input ceiling H = min(C - O, I)
- target T = floor(min(0.75 x C, H - 8,192))
- recent budget = min(15,000, floor(T x 0.1))

H is arithmetic, not a request guard. A system prompt, tool schemas, estimator
error or one large tool result can still cross a line between checks, and
recent retention follows whole turns rather than an exact count.

## Apply it

| Host | Where it goes | 200k / 32k result |
| --- | --- | --- |
| Pi 1.1.0 to 1.4.0 with the Slice preview | `pi.settings` into Pi's `settings.json`, `pi.slice` into `pi-context-memory.json`, then restart | `reserveTokens: 50000`; `keepRecentTokens: 15000` in both files |
| OpenCode 1.19.4 | `opencode.config` into the project's `opencode.json`, after checking `opencode.status` | With `limit.input: 200000`: `reserved: 50000`, `preserve_recent_tokens: 15000`, `prune: false` |
| DSH 0.2.1-rc.3 | `dsh.config` into the `@deepseek-ai/dsh-compaction-basic` entry, replacing any `retainRatio` | `thresholdRatio: 0.75`, `headroomTokens: 18000`, `retainTokens: 15000`, `maxTokens: 8192` |

**Pi.** With `--model`, the fragment goes under
`compaction.modelOverrides["<provider>/<id>"]`: other models keep Pi's defaults,
and switching models switches lines. Without it the values apply to every model.
Pi owns the trigger. The preview reads Pi's effective `reserveTokens` through
the public `getSettings()` and starts optional preparation 12.5% below that
line, so no Slice threshold has to be kept in step. Preparation stays off until
`previewPreparation.enabled` is set, as the
[preview guide](extension-preview.md#optional-preparation-experiments)
describes. A prepared note still passes the source, quotation, coverage and
disk checks before it commits; the journal still allows one paid attempt per
checkpoint interval; a failed synchronous writer still blocks.

**OpenCode.** Without `limit.input`, 1.19.4 ignores `reserved` and compacts at
C - O, 168,000 in this example. The profile then reports `needs-input-limit`,
omits `reserved` and prints the real line. Do not invent an input limit to
reach the target. V2 fields are not emitted.

**DSH.** Its default 65,536-token headroom would compact at 102,464 here, so
the profile moves DSH later while it moves Pi and OpenCode earlier. The separate
8,192-token summary cap stops DSH from spending the whole headroom on summary
output; reasoning-heavy models may need more. DSH continues a turn after a
failed summary and skips pressure compaction without capacity metadata. Both
are native behavior, and Slice adds no blocking on this host.

Fixed token settings do not follow a model switch on OpenCode or DSH, or on Pi
without `--model`. Recompute when the route or its output cap changes.

## Sources

Reviewed on 2026-10-27:

| Source | What Slice took |
| --- | --- |
| [Pi Context Plus](https://github.com/processmission/pi-context-plus) | Recompute pressure per model and act on settled boundaries. Triggering stays with the host. |
| [Oh My Pi compaction](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md) | Prepare before the trigger. Slice already did; preparation now tracks the host's actual line. |
| [Mastra observational memory](https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/docs/memory/observational-memory.mdx) | Background work separate from activation, with a synchronous path when preparation falls behind. Incremental segments remain 0.8.0 work. |
| [DSH pinned policy](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/compaction/compaction-basic/src/config.ts) | Output reservation and headroom resolved separately, recent history kept. |
| [OpenCode pinned overflow](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/overflow.ts) | Input-limit and context-only branches differ, hence the missing-input report. |

No scheduler, history database, checkpoint schema, writer fallback or
OpenCode/DSH checkpoint persistence is added; their gates stay in
[host-adapters.md](host-adapters.md). The frozen resident runtime keeps its own
budget policy.

## Validation

Unit tests cover the formula from 128k to 1M, smaller input limits, invalid
metadata and Pi's override resolution. The official Pi acceptance adds
`pressure-prepared`, through a per-model override, and `pressure-failed`,
through the global setting: three native checkpoints that reuse the prepared
note with no writer call at the boundary, recent text kept, no repeat after
small growth, and a failed preparation followed by a failed synchronous writer
that stays blocked across a cold restart. Results are in the
[validation record](validation.md).

Every fixture scripts usage and writer replies. Before recommending these
values widely, compare them with native defaults on real providers: pause P50
and P95, overflows, repeated compactions, recovery accuracy, summary truncation
and total writer and retrieval tokens.

### Native pressure simulations

Build the adapters with `node scripts/context-memory-adapters-check.mjs`. For
the official OpenCode installation in [host-adapters.md](host-adapters.md):

```sh
node scripts/context-memory-opencode-acceptance.mjs \
  --stock-root .artifacts/opencode-stock --package-dir .artifacts/host-adapters/opencode \
  --pressure-mode declared
node scripts/context-memory-opencode-acceptance.mjs \
  --stock-root .artifacts/opencode-stock --package-dir .artifacts/host-adapters/opencode \
  --pressure-mode missing-input
```

Each mode runs three automatic cycles, a failed summary with an explicit retry,
a process restart and original-evidence retrieval. The provider reports usage
just below and at the line while large synthetic text passes through the real
binary and database.

For DSH, install the pinned packages outside the source checkout:

```sh
npm install --prefix "$DSH_STOCK" --save-exact --ignore-scripts --no-audit --no-fund \
  @deepseek-ai/dsh-agent-loop@0.2.1-rc.3 \
  @deepseek-ai/dsh-session-persistence-jsonl@0.2.1-rc.3 \
  @deepseek-ai/dsh-compaction-basic@0.2.1-rc.3 \
  @deepseek-ai/dsh-tools@0.2.1-rc.3 typebox@1.3.27
node scripts/context-memory-dsh-acceptance.mjs \
  --stock-root "$DSH_STOCK" --package-dir .artifacts/host-adapters/dsh
```

This mounts the official agent loop, compaction service, token meter, JSONL
backend and built Slice plugin with a scripted provider and no network. The
official meter measures real synthetic text, including one 320 kB tool result,
across three cycles, a cold reopen, a failed summary, a smaller window and
missing capacity metadata. The fixture checks registry provenance and unchanged
service bytes, bounds calls and time, and deletes its sessions. It does not
exercise the terminal UI or a live model.
