# Codex subscription in cloud sessions

Pi can run on the maintainer's ChatGPT subscription inside a Claude Code cloud
session, through its `openai-codex` provider. The access token never enters the
VM. It is stored as a network secret, and the agent proxy attaches it to Codex
requests after they leave the session; Pi holds only a placeholder. This page
covers the setup and the renewal, which comes about every ten days.

Agents never ask for the token or the account ID in chat, and never print, log
or commit either. The account ID is not a credential, but it identifies the
account.

## How the pieces fit

| Piece | Where | Contents |
| --- | --- | --- |
| Network secret | Environment settings, Network secrets | Host `chatgpt.com`, path prefix `/backend-api/codex/`, header `Authorization`, prefix `Bearer`, value: the access token |
| Placeholder credential | `~/.pi/agent/auth.json`, written by the setup script | An `openai-codex` OAuth entry whose access value is an unsigned JWT carrying only the account ID, expiring in 2100 |
| Transport | `~/.pi/agent/settings.json`, written by the setup script | `"transport": "sse"`, because the proxy does not carry WebSocket upgrades |

Pi reads the account ID from the access token's JWT payload and sends it as
`chatgpt-account-id`, so its placeholder has to be JWT-shaped. A bare
`proxy-injected`, which the DeepSeek bench uses, fails inside Pi before any
request. The proxy replaces whatever `Authorization` header Pi sends. The far
expiry keeps Pi from refreshing: the cloud has no route to `auth.openai.com`,
and should not get one.

The refresh token stays on the maintainer's machine. OpenAI rotates refresh
tokens on every use, so one used in a disposable VM disappears with the VM, and
one taken from the everyday login would also sign that login out. Only the
access token travels, and it is replaced by hand when it expires. A login on
2026-10-19 expired on 2026-10-29.

In `/login`, choose **OpenAI Codex (legacy)**, then **Browser login**. Its
requests go to `chatgpt.com/backend-api/codex`, the Codex CLI's backend and
allowance. **OpenAI** (Sign in with ChatGPT) sends its token to `api.openai.com`
under a different `auth.json` entry, and its token lifetime has not been checked
here.

The newest Luna is `openai-codex/gpt-6-luna`. The frozen `eval/live` contract
stays on `openai-codex/gpt-5.6-luna` and refuses any other model.

## Renew the token

On the maintainer's machine. The commands are for macOS; on Linux, replace
`pbcopy` with `xclip -selection clipboard` and `pbpaste` with
`xclip -o -selection clipboard`. Keep to one terminal window, because the export
applies only there.

1. Log in with an agent directory of its own, leaving the everyday login alone:

   ```sh
   export PI_CODING_AGENT_DIR="$HOME/.pi-cloud-codex"
   pi
   # /login → OpenAI Codex (legacy) → Browser login; finish in the browser, then /quit
   ```

2. Check the token. With an empty body the server validates the token, then
   rejects the request for naming no model, so no model runs:

   ```sh
   node -e '
   const c = require(process.env.PI_CODING_AGENT_DIR + "/auth.json")["openai-codex"];
   console.log("expires:", new Date(c.expires).toLocaleString());
   fetch("https://chatgpt.com/backend-api/codex/responses", {
     method: "POST",
     headers: { Authorization: "Bearer " + c.access, "Content-Type": "application/json" },
     body: "{}",
   }).then(async (r) => console.log("status:", r.status, (await r.text()).slice(0, 200)));
   '
   ```

   `400` with `The 'None' model is not supported` means the token works. `401`
   means it does not, so log in again. `Cannot find module` means the login
   landed in another directory; repeat step 1 in this window.

3. Copy the token, then check the clipboard:

   ```sh
   node -e 'process.stdout.write(require(process.env.PI_CODING_AGENT_DIR+"/auth.json")["openai-codex"].access)' | pbcopy
   pbpaste | wc -c       # one to two thousand characters
   pbpaste | cut -c1-6   # eyJhbG, the fixed start of every JWT
   ```

4. Open the environment's settings (the cloud environment menu in the session's
   title bar, then Edit) and delete the old `chatgpt.com` secret, since secrets
   cannot be edited. Add a new one: Allowed websites `chatgpt.com`, Path prefixes
   `/backend-api/codex/`, header name `Authorization`, prefix `Bearer`, and only
   the token as the value. Copy nothing between step 3 and the paste. The first
   secret this setup saved was not a token, and every request returned 401.

5. Only if the login used a different ChatGPT account, print the new account ID
   and update the setup script:

   ```sh
   node -e 'console.log(require(process.env.PI_CODING_AGENT_DIR+"/auth.json")["openai-codex"].accountId)'
   ```

A running session picks up the new secret without restarting.

## Verify from a cloud session

In auto mode, Claude Code's safety check refused these steps until the
maintainer allowed them in the conversation. Ask once for all three, send each
request once, and do not retry.

1. Confirm that `~/.pi/agent/auth.json` and `~/.pi/agent/settings.json` exist,
   without printing them.

2. Check the proxy and the secret. As in the local check, no model runs:

   ```sh
   curl -sS -m 20 -X POST https://chatgpt.com/backend-api/codex/responses \
     -H 'Content-Type: application/json' -d '{}' -w '\n[status %{http_code}]\n'
   ```

3. Run `node scripts/context-memory-ops.mjs build`, then send one Pi request from
   an empty directory:

   ```sh
   node "$REPO/packages/coding-agent/dist/bundle/cli.js" -p "Reply with exactly: OK" \
     --model openai-codex/gpt-6-luna --thinking low --no-session --no-extensions
   ```

   On 2026-10-19 this answered `OK` and exited 0.

## When it fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| curl reports status `000`, and the proxy status lists a 403 for `chatgpt.com` | No secret covers the path, so the network policy blocks the host | Add the secret |
| Cloud step 2 returns 401 `Could not parse your authentication token` | The secret's value is not the token, or carries a second `Bearer` | Renew from step 3 |
| Pi exits 1 with `your ChatGPT login did not make it to this service` | Seen with the same malformed secret | Confirm with cloud step 2, then renew from step 3 |
| The local check returns 401 | The token expired or was revoked | Renew from step 1 |
| Pi finds no credential for `openai-codex`, or tries WebSocket | The placeholder or the transport setting is missing: the snapshot predates the setup script, or the script has no account ID | Fix the setup script and save it, then start a new session |

## The setup script's Pi section

The setup script runs before Claude Code starts and did not see the
environment's variables, so the account ID is written into the script itself.
Its result is cached as a filesystem snapshot that later sessions reuse. The
script runs again only after it or the allowed hosts change, or when the cache
expires after about seven days. A script that exits non-zero stops the session
from starting, hence the trailing `|| echo`.

```bash
# Pi: placeholder openai-codex credential. The real access token is a network
# secret on chatgpt.com/backend-api/codex/, attached by the agent proxy outside
# the VM. Pi only needs a JWT-shaped value carrying the account ID, which it
# copies into the chatgpt-account-id header. The far expiry keeps Pi from
# refreshing; a 401 from Codex means the network secret needs a new token.
# The account ID lives here, not in Environment variables: this script runs
# before Claude Code loads those, and its result is cached as a snapshot.
# Standard base64, not base64url, because Pi decodes the payload with atob.
# SSE because the agent proxy does not carry WebSocket upgrades.
export PI_CODEX_ACCOUNT_ID="<account ID>"
mkdir -p ~/.pi/agent
node -e '
  const fs = require("fs"), dir = require("os").homedir() + "/.pi/agent";
  const id = process.env.PI_CODEX_ACCOUNT_ID;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const access = [b64({ alg: "none" }), b64({ "https://api.openai.com/auth": { chatgpt_account_id: id } }), "proxy-injected"].join(".");
  const read = (f) => { try { return JSON.parse(fs.readFileSync(dir + f, "utf8")); } catch { return {}; } };
  const auth = read("/auth.json");
  auth["openai-codex"] = { type: "oauth", access, refresh: "proxy-injected", expires: Date.parse("2100-01-01"), accountId: id };
  fs.writeFileSync(dir + "/auth.json", JSON.stringify(auth, null, 2), { mode: 0o600 });
  const settings = read("/settings.json");
  settings.transport = "sse";
  fs.writeFileSync(dir + "/settings.json", JSON.stringify(settings, null, 2));
' || echo "pi-ops: could not write the Pi Codex placeholder" >&2
```

Keep the JavaScript free of single quotes; it sits inside `node -e '...'`.
