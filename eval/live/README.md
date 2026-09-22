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

## Bounded concurrency

Budget version `0.3-live-budget.4` keeps all sample and resource limits unchanged.
One process owns one shared ledger. An exclusive owner file protects the artifact
root; a second process or implicit replay against an existing plan is refused. The first F1/project/r1 writer request completes
alone. If it triggers a global stop, the paired native run never starts. Otherwise
the runner schedules one project/native pair at a time with at most two runs in
flight; each run's checkpoints and probes remain sequential. The next pair starts
only after both current runs terminate. Admission reserves shared quota synchronously,
and a global stop aborts other in-flight requests. Unknown reservations remain held.

Judges start after the baseline phase, with two independent F3-review workers by
default; the CLI can explicitly select four. Per-run review calls remain sequential,
so their private transport/context and quotas cannot cross. There is no automatic
ramp to four or expansion of the budget. All limits still apply in aggregate.

The first completed F1 pair records its wall time and a rough extrapolation for
eight remaining pairs. This is only an early planning estimate: F2 is larger,
F3 differs, and quota/cache/latency may change. The 924-minute limit is a worst-case
stop window, not a duration prediction. Results record concurrency as a comparison
condition. A stopped prior plan is not resumed or rerun by this code change;
its failed slot, held unknown usage and artifacts remain authoritative.

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
redirects and additional network calls are refused. Request headers are not persisted. HTTP status, terminal SSE event types, and
bounded error bodies are recorded only after credential/Authorization redaction. Calls, admission, usage, fallback and terminal states
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
  EVAL_LIVE_APPROVAL=0.3-live-budget.4 \
  node --experimental-strip-types eval/live/cli.ts execute \
  "$OUTPUT_DIR" "$APPROVAL_REFERENCE" 2
```

Normal CI retains `PI_OFFLINE=1`, `EVAL_PROVIDER_MODE=scripted`, and
`EVAL_MODEL_CALL_BUDGET=0`, including when running `eval/live/live.test.ts`.

## One authorized diagnostic after an unknown-usage stop

`diagnose-cli.ts` accepts the exact stopped plan JSON and an explicit diagnostic
authorization reference. It reuses the recorded first F1/project/r1 writer context
once, retains the previous unknown input/output reservations and sent-call count,
and subtracts elapsed time from the original global deadline. It does not allocate
a new global budget, run probes, or automatically retry. An exclusive claim file
prevents this one-request authorization from being used twice. Evidence is written
under the stopped plan, without changing the original failure records.

The response observer records sanitized HTTP status/content type/error body and
SSE event types. It separately parses complete SSE data frames, including multiline
data, to detect usage that the accounting parser may have missed. This observation
does not itself change accounting or permit continuation. A successful diagnostic
ends for evidence review just as a failed one does. A plan restart requires the
specific authorized condition and must carry forward every earlier attempt.

A second, separately authorized diagnostic accepts the first diagnostic JSON as
its predecessor (attempt 2, cumulative requests 2). It inherits both attempts'
reservations and the original deadline, and uses a separate exclusive claim.
Before attempt 3 it performs one DNS lookup and one TCP connection to the backend
host on port 443, with no credentials, TLS or HTTP payload. Failed self-checks
stop before provider dispatch; passing checks allow exactly one writer request,
then stop for review regardless of its outcome. This is not a general resume CLI.

Both live CLIs emit a startup environment record containing known network-guard
names and booleans plus names of present proxy variables. Values are never logged;
unknown fetch wrappers cannot be exhaustively detected. No guard is disabled.
Pre-Response fetch rejections persist redacted name, message, code, errno, first
stack line, cause chain and AggregateError branches. These failures are classified
as `EVAL_PROVIDER_TRANSPORT_FAILURE`; missing actual usage remains unknown and
its full reservation stays held. This classification does not prove the remote
server received or executed the request.

## Explicit replay using local output limits

After a separately authorized rejection-to-local transition, `restart-local`
accepts the third diagnostic JSON as the final CLI argument (after judge
concurrency). Its predecessor must record three cumulative attempts and the
HTTP 400 unsupported-parameter response. A claim beside that predecessor prevents
reusing it to start multiple plans, even under different output directories.
The replay has a fresh artifact directory and starts at run 1. Original failures
and unknown reservations remain intact. Both global and baseline allocations
inherit all earlier calls and held reservations; elapsed time is subtracted from
the original windows. Per-run execution chains start fresh as explicitly authorized.

The shared ledger begins in `local-post-response` mode, and every writer, task,
native and judge payload omits `max_output_tokens`. Output, action, call and time
checks remain active. Actual usage is required on successful responses; missing
usage stops globally without a retry or proxy-accounting substitution. Earlier
unknown consumption is not relabeled zero. Local rejection cannot stop tokens
already generated remotely, so reported usage and held reservations remain part
of aggregate enforcement. The plan records both this replay's request count and
the cumulative count including the three historical attempts.
