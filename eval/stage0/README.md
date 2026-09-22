# Offline interface gate

This is a provisional adapter experiment, not a frozen evaluation schema or a
provider-quality baseline. It exercises the pinned host's SDK, native compactor,
resident compactor, persisted checkpoints, reopening, and one scripted continuation
probe. Runtime code is unchanged. The synthetic sizing scaffold is deliberately
not the decision-dense F1 fixture.

Run from the repository root, with an absolute output directory outside the
public repository:

```sh
PI_OFFLINE=1 STAGE0_ARTIFACT_DIR="$OUTPUT_DIR" \
  node node_modules/vitest/dist/cli.js run \
  --config packages/coding-agent/vitest.config.ts \
  eval/stage0/interface-gate.test.ts
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p eval/stage0/tsconfig.json
```

The test registers only an in-process scripted provider with a reserved `.invalid`
endpoint, disables catalog network access, uses in-memory fake authentication,
blocks fetch, and rejects unexpected scripted calls. No real provider is invoked.
Every execution creates a fresh evidence directory; failures are retained. JSON
artifacts include exact source ID lists, cuts, budgets, request captures, tool
traces, and timing. Timings and zero-valued scripted usage are interface evidence,
not product latency or live token measurements.

Native means the native compactor on the same pinned distribution with the
resident disabled, not a separately installed stock Pi binary. Native settings
retain the default 20,000 tokens. The resident uses its default zero retained
budget, session writer and enabled repair. Both trigger only after completed
turns. Ordinary read/write tools use isolated in-memory operations; no shell or
other filesystem tools are exposed. History is enabled only for the resident arm.

The full fixture/scorer contract, CI integration and general runner belong to
later stages. No schema is frozen by this experiment.
