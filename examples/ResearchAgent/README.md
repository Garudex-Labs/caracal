# Research agent

A terminal Q&A agent that answers questions from your Google Drive documents
and Calendar events using OpenAI (**GPT-5.4 mini**). It is a plain Node.js
program with **no Caracal dependency** — `caracal run` injects the three
provider credentials when it starts:

| Injected env | Resource | Used for |
| --- | --- | --- |
| `GOOGLE_DRIVE_ACCESS_TOKEN` | `resource://google-drive` | Searching and reading Drive documents |
| `GOOGLE_CALENDAR_ACCESS_TOKEN` | `resource://google-calendar` | Reading Calendar events |
| `OPENAI_API_KEY` | `resource://openai` | Answering with the LLM |

## Try it

After the one-time setup below:

```bash
cd examples/ResearchAgent
cp env.example .env          # fill in your zone and application IDs
. .env
caracal run -- node agent.mjs
```

```text
[agent] credential preflight (values masked, injected by launcher):
[agent]   GOOGLE_DRIVE_ACCESS_TOKEN  present  -> Google Drive (read-only scope)
[agent]   GOOGLE_CALENDAR_ACCESS_TOKEN  present  -> Google Calendar (read-only scope)
[agent]   OPENAI_API_KEY  present  -> OpenAI
Caracal run research agent ready. Ask about Drive docs or Calendar events. Type "exit" to quit.
> What meetings do I have about the checkout incident?
[agent] drive: 2 matching document(s)
[agent] calendar: 3 relevant event(s)
[agent] openai: answered with gpt-5.4-mini
...
```

Offline tests need no Caracal or provider accounts:

```bash
pnpm test
```

## Why caracal run

Normally each agent gets long-lived Google and OpenAI secrets in `.env`
files. `caracal run` replaces that:

- **No secrets on disk.** Tokens exist only in the child-process env and
  vanish on exit.
- **Least privilege.** Google tokens carry only read-only scopes; each
  resource is exchanged under a policy decision.
- **Short-lived.** Credentials expire with the run TTL (15 minutes maximum).
- **Clean environment.** Only PATH-like variables and the mapped credentials
  reach the agent.
- **Audited.** Every exchange is an authenticated STS call by a named
  application in a zone.

The agent needs zero changes: it just reads provider-native env vars, like
any existing tool. Started directly with `node agent.mjs`, it exits with
code 2 before any network call — the credentials only exist when the
launcher injects them.

## One-time setup

### 1. Console

Run `caracal console` and create:

1. A zone (e.g. `Pied Piper Production`) and a managed confidential
   application (e.g. `PiperNet AI Research Agent`). Keep the one-time client
   secret.
2. Three providers, each with `allow_runtime_injection = true`:
   - Google Drive: OAuth/token-broker provider, scope
     `https://www.googleapis.com/auth/drive.readonly`.
   - Google Calendar: same, scope
     `https://www.googleapis.com/auth/calendar.readonly`.
   - OpenAI: API-key or brokered provider; store the OpenAI secret in
     Console, never in this repo.
3. Three resources mapped to those providers:

   | Identifier | Upstream URL |
   | --- | --- |
   | `resource://google-drive` | `https://www.googleapis.com/drive/v3` |
   | `resource://google-calendar` | `https://www.googleapis.com/calendar/v3` |
   | `resource://openai` | `https://api.openai.com/v1` |

4. A policy allowing the application to request all three resources.

The read-only scopes are the least-privilege grant: the agent only reads
Drive (`https://www.googleapis.com`) and Calendar, and a write attempt with
these tokens is refused upstream. Prefer a service-account or token-broker
flow for Google; `caracal run` is not an OAuth consent UI, so user-delegated
grants must already exist.

### 2. Local runtime files

The launcher auto-detects the client secret and the credential mapping under
`~/.config/caracal/runtime/<zone_id>/<application_id>/`:

```bash
export CARACAL_ZONE_ID="zone_prod"
export CARACAL_APPLICATION_ID="app_support_research_agent"
CARACAL_RUNTIME_DIR="$HOME/.config/caracal/runtime/$CARACAL_ZONE_ID/$CARACAL_APPLICATION_ID"
mkdir -p "$CARACAL_RUNTIME_DIR"

install -m 600 /dev/null "$CARACAL_RUNTIME_DIR/client-secret"
printf '%s' '<paste-one-time-client-secret-here>' > "$CARACAL_RUNTIME_DIR/client-secret"

cat > "$CARACAL_RUNTIME_DIR/credentials.json" <<'JSON'
[
  {
    "env": "GOOGLE_DRIVE_ACCESS_TOKEN",
    "resource": "resource://google-drive",
    "credential_type": "provider_token"
  },
  {
    "env": "GOOGLE_CALENDAR_ACCESS_TOKEN",
    "resource": "resource://google-calendar",
    "credential_type": "provider_token"
  },
  {
    "env": "OPENAI_API_KEY",
    "resource": "resource://openai",
    "credential_type": "provider_token"
  }
]
JSON
```

Use your Console values for the zone and application IDs. The mapping file is
not secret; it only says which resource fills which env var.
`credential_type = "provider_token"` injects the provider-native token;
use `caracal_mandate` only for workloads that consume Caracal mandates.

`env.example` carries the matching bootstrap variables (`CARACAL_ZONE_ID`,
`CARACAL_APPLICATION_ID`, `CARACAL_RUN_TTL_SECONDS`) — never provider
secrets. Alternatively, put everything in a TOML runtime profile and point
`CARACAL_CONFIG` at it.

## Files

| File | Purpose |
| --- | --- |
| `agent.mjs` | The interactive CLI agent launched by `caracal run` |
| `env.example` | Bootstrap-only environment example |
| `tests/agent.test.mjs` | Offline tests: syntax, fail-closed preflight, doc consistency |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `[agent] missing ...` (exit 2) | Launch through `caracal run` with the setup files in place. |
| `runtime config is required to run a command` | Source `.env` or set `CARACAL_CONFIG`. |
| Permission error on a profile or secret file | `chmod 600` the file. |
| `"reason": "step_up_required"` | Approve the challenge in Console; the launcher resumes. |
| `provider_credential_unavailable:<resource>` | Enable `allow_runtime_injection = true` on the provider. |
| Google 401/403 during a question | Token expired (relaunch) or provider scopes too narrow. |

Good to know: injected env vars are static for the process lifetime, so
long-running agents must finish before the TTL or be relaunched. The same
launch pattern works in CI jobs, container entrypoints, and schedulers —
anywhere a process starts with `caracal run --`.
