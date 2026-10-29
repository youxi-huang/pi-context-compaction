# OpenAI API in cloud sessions

Pi, OpenCode and DSH reach OpenAI's official API from a Claude Code cloud
session on the maintainer's API key. The key never enters the VM. It is stored
as a network secret, and the agent proxy attaches it to requests for
`api.openai.com/v1/` after they leave the session; each host holds only a
placeholder. This replaced the ChatGPT Codex subscription on 2026-10-29.

Agents never ask for the key in chat, and never print, log or commit it.

## How the pieces fit

| Piece | Where | Contents |
| --- | --- | --- |
| Network secret | Environment settings, Network secrets | Host `api.openai.com`, path prefix `/v1/`, header `Authorization`, prefix `Bearer`, value: the key alone |
| Placeholder | The environment of each command that needs it | `OPENAI_API_KEY=proxy-injected`. No host sends a request without a non-empty key; the proxy replaces the whole `Authorization` header |

The placeholder is not a session-wide environment variable. Upstream's vitest
suite turns on end-to-end tests when it finds a provider key, and behind this
secret they would reach the paid API. The preview bench sets the placeholder
itself for `--provider openai`.

A project of its own on the OpenAI platform, with its own key and a budget,
keeps a runaway run bounded. Secrets cannot be edited: to rotate, delete the
secret and add a new one. A running session picks up the change without
restarting.

## Verify

No model runs:

```sh
curl -sS -m 20 -o /dev/null -w '%{http_code}\n' https://api.openai.com/v1/models
```

`200` means the secret is attached. `000`, with the proxy status listing a 403
for `api.openai.com`, means no secret covers the path. `401` means the
secret's value is not the key, or carries a second `Bearer`.

Then one request per host, each from an empty directory, Pi's after
`node scripts/context-memory-ops.mjs build`. On 2026-10-29 each answered `OK`
and exited 0:

```sh
OPENAI_API_KEY=proxy-injected node "$REPO/packages/coding-agent/dist/bundle/cli.js" \
  -p "Reply with exactly: OK" --model openai/gpt-6-luna --thinking low --no-session --no-extensions
```

```sh
OPENAI_API_KEY=proxy-injected opencode run -m openai/gpt-6-luna "Reply with exactly: OK"
```

```sh
OPENAI_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1 dsh --profile headless "Reply with exactly: OK"
```

Run OpenCode with its own `HOME` and `XDG_*` directories, and DSH with its own
`DSH_HOME`, so that neither reads or changes an everyday installation.

## Hosts

| Host | Wiring | GPT-6 Luna as the host sees it |
| --- | --- | --- |
| Pi | Reads `OPENAI_API_KEY`; model `openai/gpt-6-luna`. Preview bench: `--provider openai` | 272,000 context, 128,000 output |
| OpenCode 1.19.4 | Reads `OPENAI_API_KEY`; model `openai/gpt-6-luna` | 1,050,000 context, 922,000 input, 128,000 output, from models.dev |
| DSH 0.2.1-rc.3 | `@deepseek-ai/dsh-llm-pi-ai` resolves the key, and the default model points at it (below) | 272,000 context, 128,000 output, from its bundled `pi-ai` 1.4.0 |

DSH's `headless` profile mounts `dsh-llm-pi-ai` with no routes and starts
agents on `deepseek-official/deepseek-flash`. In that profile's
`cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
- id: agent-default-model
  config:
    provider: openai
    model: gpt-6-luna
```

Without the key DSH stops before any request with `MISSING_CREDENTIAL` for
route `openai`, which also confirms it is not falling back to DeepSeek, whose
key the proxy supplies as well.

## The 272,000-token line

OpenAI bills a GPT-6 Luna request whose input exceeds 272,000 tokens at the
long-context rate for the whole request: twice the input and cache prices and
1.5 times the output price, by Pi's catalog. Pi and DSH cap Luna's window at
that line. OpenCode does not: without a `limit.input` of its own it compacts
far past the line, near its 922,000-token input limit. Keep measured requests below 272,000 input
tokens on every host, and size capacity profiles from that line rather than
from the model's full window ([capacity profiles](context-pressure.md)).

## Prompt cache

Pi's OpenAI provider sends the session's ID as `prompt_cache_key`, and the
preview's session writer sends the same ID, so a compaction reads the prefix
the session has already cached. Luna declares the explicit cache mode: by
default Pi asks for nothing more, and with `PI_CACHE_RETENTION=long` it asks for
a 30-minute lifetime. Catalog prices are estimates, not invoices; usage and
cache reads come from OpenAI's own counts.
