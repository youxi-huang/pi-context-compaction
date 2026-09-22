# Explicit subscription evaluation

This harness runs the existing checkpoint runner through the frozen
`openai-codex/gpt-5.6-luna` provider, with thinking `max`. It does not modify the
runtime or source fixtures. Measurement `0.3-measurement.2` changes only the
numeric output allowance: 8,192 tokens per task probe including reasoning,
two mutations, three tool rounds and at most four task requests. Historical
scripted tests continue to exercise measurement 1. The numeric scoring view is
explicit and does not rewrite fixture files or prompts.

`contract.ts` is the executable budget table. Eighteen paired runs reserve
1,608 calls, 36,600,000 input tokens/proxy allowance, 4,048,512 output tokens and
840 minutes. Option-C judges add at most 84 calls, 2,688,000 input allowance,
442,368 output tokens and 84 minutes. The combined limits are 1,692 calls,
39,288,000 input allowance, 4,490,880 output tokens and 924 minutes. Input usage
and the byte-based proxy are distinct counters. Per-run and per-checkpoint
limits cannot borrow from other runs.

All CI tests use a synthetic credential and injected fake fetch under network
denial. They call the actual provider serializer and the actual SDK compactor,
including size repair and native split summaries. An offline 18-run test then
performs the 60 selected semantic observations plus 12 fixed rechecks. Those
responses are scripted and establish no model-quality or server-cap claims.

## Transport and accounting

The transport forwards tool choice, cache retention and session identity, pins
SSE and zero retries, and adds `max_output_tokens` through `onPayload`. The
first actual request is the first F1/project/r1 writer slot; there is no extra
warmup request. If returned usage exceeds the requested cap, or the terminal
response does not confirm it, the user-authorized fallback becomes
`local-post-response`. Subsequent requests omit the unconfirmed cap. Over-limit
output is rejected before task tools or checkpoint commit; its known usage is
retained. The plan continues under local limits until an aggregate budget or
another stop condition occurs. A reported cap is not proof of server enforcement.

The injected fetch observes terminal SSE usage while the provider's own parser
consumes the same stream. Missing input/output stops the plan and holds the full
reservation. Optional cache/reasoning/total fields remain null when absent;
provider default zeros are not evidence. Subscription monetary cost is unavailable,
not the catalog's API-equivalent estimate. No paid fallback is enabled.

Before dispatch, the ledger reserves `ceil(1.5 * ceil(payloadBytes/3)) + 2048`
input units and the full requested output ceiling. This input estimate has no
proven tokenizer error bound; actual usage is reported separately and an input
reservation overrun stops the plan. Output overrun triggers the authorized local
fallback, but aggregate token/time/call overruns stop. This cannot reclaim remotely
consumed tokens. HTTP failures, timeouts and unknown usage stop without retry.
An HTTP rejection of the added parameter is an error, not evidence that the
parameter was merely ignored; the zero-retry/unknown-usage rule still applies.

OAuth is read from the existing Pi credential store into memory, without login,
refresh, key export, configuration changes or logging. Expired/unavailable
credentials stop. Only the exact Codex responses endpoint can receive requests;
redirects and additional network calls are refused. Headers and provider error
text are not persisted. Calls, admission, usage, fallback and terminal states
are journaled under the caller's internal artifact directory.

## Semantic observations

The judge model is also subscription Luna/max. The exact
`f3-writer-promotion.1` rubric is in `rubric.ts`. Each observation has a new
anonymous artifact ID, one JSON data message, a fixed trusted system, and no
tools or reused response/thread state. Gold expected-allowed flags, another
arm's outputs, task execution traces and other replicate outputs never enter
the judge request. Entire artifact fields and source evidence remain data.
Schema, exact quotations, source IDs and inspected fields are checked locally.
Ambiguous and conflicting observations remain unresolved.

Option C reviews both replicate-1 artifacts in full (40 observations), plus
five preselected cases per arm in replicates 2 and 3 (20 more). It makes two
fixed blind rechecks and permits two anomaly rechecks per F3 run. Primary
requests cap total output at 4,096; rechecks at 8,192. All include reasoning.
The remaining 60 observations are explicitly unreviewed/blocked. Model
rechecks are not independent human review. Run JSON, Markdown, per-probe
records and scores are updated without rerunning the task or writer.

## Authorized execution only

After the preflight report has received final authorization, an operator may
set the following controls and invoke the dedicated CLI. `OUTPUT_DIR` is an
absolute internal evidence directory and `APPROVAL_REFERENCE` records that
specific authorization. Do not run this command as a test or preflight.

```sh
PI_OFFLINE=0 EVAL_PROVIDER_MODE=live EVAL_MODEL_CALL_BUDGET=1692 \
  EVAL_LIVE_APPROVAL=0.3-live-budget.3 \
  node --experimental-strip-types eval/live/cli.ts execute \
  "$OUTPUT_DIR" "$APPROVAL_REFERENCE"
```

Normal CI retains `PI_OFFLINE=1`, `EVAL_PROVIDER_MODE=scripted`, and
`EVAL_MODEL_CALL_BUDGET=0`, including when running `eval/live/live.test.ts`.
