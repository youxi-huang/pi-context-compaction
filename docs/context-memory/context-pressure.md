# Capacity profiles and earlier preparation

For a verified 200,000-token context window and a 32,000-token output
reservation, this opt-in profile targets native compaction at 150,000 tokens,
retains a recent 15,000-token budget, and lets Pi's existing optional preparation
start at 131,250. These are initial experiment parameters, not measured optima.
The same calculation handles 128k and larger windows; there is no 200k branch.

## Generate a profile

From a source checkout on Node 22.19 or newer:

```sh
node scripts/context-memory-pressure-profile.mjs \
  --context 200000 --output 32000 --input 200000
```

Supply the provider's verified combined window, effective request output
reservation (including reasoning where counted), and separate input limit if
declared. Omit `--input` if unknown. A fallback displayed by a host is not
capacity evidence. Invalid, contradictory or missing required limits are
rejected. Plausible but incorrect metadata cannot be detected by this tool.
It prints JSON fragments and never edits settings or calls a provider.

With combined capacity C, output reservation O and optional input ceiling I:

- Calculated input ceiling H = min(C − O, I if declared).
- Target T = floor(min(0.75 × C, H − 8,192)).
- Preparation starts at max(0, T − clamp(floor(T × 0.125), 8,192, 32,768)).
- Recent-text budget = min(15,000, floor(T × 0.1)).

The preparation lead comes from the existing Pi experiment. The 75% target,
8,192-token extra margin and recent budget are conservative starting choices.
H is a calculation, **not an added request guard**. Tools, system prompts,
token-estimator error and a single large result can cross a host's threshold
between checks. Recent retention follows whole-turn/tool-pair boundaries and
is not an exact count of the text eventually retained.

## Apply to the selected host

| Host | Fragment and scope | 200k / 32k example |
| --- | --- | --- |
| Stock Pi 1.1.0–1.4.0 + Slice preview | Merge `pi.settings` into the chosen project or agent `settings.json`; merge `pi.slice` into that agent's `pi-context-memory.json`, then restart. | `reserveTokens: 50000`, host and Slice `keepRecentTokens: 15000`, Slice `compactAt: 150000`. |
| OpenCode 1.19.4 | Merge `opencode.config` into the dedicated project's `opencode.json`; inspect `opencode.status` first. The existing Slice tool still only retrieves evidence. | With declared `limit.input: 200000`: `reserved: 50000`, `preserve_recent_tokens: 15000`, `prune: false`. |
| DSH 0.2.1-rc.3 | Apply `dsh.config` to the existing `@deepseek-ai/dsh-compaction-basic` entry. Remove an explicit `retainRatio` when selecting `retainTokens`. Keep the Slice history plugin separately. | `thresholdRatio: 0.75`, `headroomTokens: 18000`, `retainTokens: 15000`, summary `maxTokens: 8192`. |

Pi's `compactAt` still does not schedule compaction. Both Pi and Slice settings
are needed: the host owns the trigger, while Slice owns its note and retention
budgets. The patch lowers the preparation band only when `compactAt` is
explicitly supplied; it leaves the default band and default retention unchanged.
If preparation is wanted, also explicitly enable the existing experiment:

```json
{ "previewPreparation": { "enabled": true } }
```

Preparation pays for a writer call earlier. A ready candidate still passes the
source, quotation, coverage and disk-confirmation checks. A stale or unusable
candidate uses the existing synchronous path. The journal already limits paid
preparation to one attempt per checkpoint interval, including across restart;
it does not suppress manual compaction or safety checks. No cooldown is added
to a host's overflow handling. A failed synchronous Slice writer still blocks.

Without `limit.input`, OpenCode 1.19.4 ignores `reserved`: its calculated line
in this example remains 168,000. The output says `needs-input-limit`, omits an
ineffective reservation, and reports that actual line. Do not manufacture model
metadata to force a trigger. V2 fields are deliberately not emitted.

DSH's default 65,536-token headroom would produce 102,464 in this example.
The profile therefore moves DSH's line **later**, while moving default Pi and
OpenCode earlier. Its separate summary cap prevents DSH from using the entire
headroom as summary output. An 8,192 cap may still be insufficient for some
reasoning models; measure truncation and adjust it for that route. Native DSH
failure behavior remains its own; this is not a Slice checkpoint writer.

Use a dedicated model/project profile. Recompute and reapply it when switching
route, capacity or effective output cap: native fixed token settings do not
automatically follow model switches. Pi preparation does recompute its band
from the current context and Slice budget, and never postpones the default band.

## Sources and scope of borrowing

Reviewed for this patch on 2026-10-27:

| Project/source | Useful idea and application |
| --- | --- |
| [Pi Context Plus](https://github.com/processmission/pi-context-plus) | Recompute model-relative pressure and use settled boundaries. Slice keeps host triggering and only adjusts its existing preparation boundary. |
| [Oh My Pi compaction](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md) | Prepare before the trigger and keep appended originals. Slice already has this mechanism; the patch aligns its lead with an explicitly lowered budget. |
| [Mastra observational memory](https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/docs/memory/observational-memory.mdx) | Separate background work from activation, with a synchronous path when preparation cannot keep up. Incremental segments remain the shared 0.8.0 work, not part of this patch. |
| [DSH pinned policy](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/compaction/compaction-basic/src/config.ts) | Resolve output reservation and headroom separately, keep balanced recent history. The generated native fragment follows that policy. |
| [OpenCode pinned overflow implementation](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/overflow.ts) | Its input-limit and context-only branches differ. The generator reports the missing-input case rather than promising an ineffective threshold. |

No new scheduler, history database, checkpoint schema, writer fallback or
OpenCode/DSH checkpoint persistence is introduced. Their prerequisites remain
in [host-adapters.md](host-adapters.md). The capacity calculator does not replace
the frozen resident runtime's budget policy.

## Validation

The core tests cover 128k, 200k, 262,144 and 1M windows, smaller input limits,
large output reservations, invalid metadata and bounded retention. CLI tests
check native formula mappings and the OpenCode limitation. Pi regressions
exercise early preparation, three checkpoint intervals, retained current text,
reopening original evidence, failed summaries, smaller-model recalculation and
an oversized request payload. Token usage and writer replies in those tests
are scripted; they are not a live 200k provider stress test.

Run `node scripts/context-memory-ops.mjs verify`, then build and accept the
preview on the official Pi versions listed in [extension-preview.md](extension-preview.md).
The stock acceptance now includes `pressure-prepared` and `pressure-failed`:
three native automatic checkpoints, preparation reuse without a boundary writer
call, no immediate repeat after small growth, recent raw text, failed preparation
followed by a failed synchronous writer, and cold-process recovery or blocking.

Before recommending these values broadly, compare real-provider pause P50/P95,
overflows, repeated compactions, recovery accuracy, summary truncation and total
writer/retrieval tokens with native defaults. Long-history retrieval still
reads the original host log on each query; measure host I/O as well as the
projection before adding an optimization.

### Native pressure simulations

Build the retrieval adapters with `node scripts/context-memory-adapters-check.mjs`.
For the official OpenCode installation described in [host-adapters.md](host-adapters.md):

```sh
node scripts/context-memory-opencode-acceptance.mjs \
  --stock-root .artifacts/opencode-stock --package-dir .artifacts/host-adapters/opencode \
  --pressure-mode declared
node scripts/context-memory-opencode-acceptance.mjs \
  --stock-root .artifacts/opencode-stock --package-dir .artifacts/host-adapters/opencode \
  --pressure-mode missing-input
```

Both modes run three automatic cycles, then a failed summary and explicit
recovery, followed by process restart and original-evidence retrieval. The
provider reports controlled usage just below/at the line; large synthetic
source text is sent through the actual binary and native database.

For DSH, choose an isolated npm installation outside the source checkout:

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
backend and built Slice plugin, with a scripted provider adapter and no network.
It uses native token estimates of large source text, including a single 320 kB
tool result, three pressure cycles, cold-process reopening, writer failure and
recovery, smaller capacity and missing capacity metadata. DSH continues after
a failed pressure summary and skips pressure compaction when capacity is absent;
those are verified native limitations, not Slice failure protection. The fixture
checks registry provenance and unchanged service bytes, bounds calls/time and
deletes synthetic sessions. It does not exercise the terminal UI or a live model.
