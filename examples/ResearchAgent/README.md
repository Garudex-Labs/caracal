# caracal run Google Drive + Calendar research agent

This is the primary `caracal run` showcase example. It demonstrates a real
external CLI agent where Caracal injects provider-native credentials at launch:

- Google Drive OAuth token for document context.
- Google Calendar OAuth token for schedule context.
- OpenAI key for the LLM call.

The agent has no Caracal SDK dependency. It behaves like a normal third-party
terminal tool: read provider-native environment variables, call Google Drive,
call Google Calendar, call OpenAI, answer the user's question, and keep running
until the user exits.

## Important: Console owns provider setup

Do not pass provider base URLs, model names, scopes, provider IDs, policies,
resource mappings, or credential env names as command-line flags to the agent.
Those belong in Caracal Console and the runtime profile generated from Console.

The command is intentionally simple:

```bash
caracal run -- node agent.mjs
```

If you want an env-file style setup, copy `env.example`, replace the Console
values, source it, and run the agent:

```bash
mkdir -p ~/.config/caracal/research-agent
cp env.example ~/.config/caracal/research-agent/env
chmod 600 ~/.config/caracal/research-agent/env
$EDITOR ~/.config/caracal/research-agent/env
. ~/.config/caracal/research-agent/env
caracal run -- node agent.mjs
```

`env.example` contains only Caracal bootstrap settings. It must not contain
Google or OpenAI credentials; Caracal injects those only into the launched child
process.

After launch, the agent opens an interactive terminal prompt:

```text
Caracal run research agent ready. Ask about Drive docs or Calendar events. Type "exit" to quit.
> What meetings do I have about the checkout incident, and what does Drive say caused it?
```

The model is hardcoded in the agent as **GPT-5.4 mini** (`gpt-5.4-mini`). In
Console, configure the resource upstream URLs to match the real public APIs the
agent uses:

| Resource | Console upstream URL | Endpoint used by the agent |
| --- | --- | --- |
| `resource://google-drive` | `https://www.googleapis.com/drive/v3` | `https://www.googleapis.com` |
| `resource://google-calendar` | `https://www.googleapis.com/calendar/v3` | `https://www.googleapis.com` |
| `resource://openai` | `https://api.openai.com/v1` | `https://api.openai.com/v1` |

If your deployment needs alternate endpoints, create separate resources and
providers in Console and use an agent build that calls those endpoints. Do not
pass endpoint overrides to this agent at launch time.

## Runtime resources

At runtime Caracal exchanges three resources:

| Resource | Provider concept | Injected env | Used for |
| --- | --- | --- | --- |
| `resource://google-drive` | Google OAuth provider with Drive read scope | `GOOGLE_DRIVE_ACCESS_TOKEN` | Searching and exporting relevant Drive documents |
| `resource://google-calendar` | Google OAuth provider with Calendar read scope | `GOOGLE_CALENDAR_ACCESS_TOKEN` | Reading relevant Calendar events |
| `resource://openai` | OpenAI API-key provider or short-lived broker | `OPENAI_API_KEY` | Answering the user's terminal question |

For provider-native injection, each provider must explicitly opt in with
`allow_runtime_injection = true`, and each run credential mapping must use
`credential_type = "provider_token"`. Use
`credential_type = "caracal_mandate"` only for workloads that know how to consume
Caracal mandates directly.

## Why this shows the provider concept

Drive and Calendar show why `caracal run` is different from plain `.env`
injection:

1. The protected things are third-party provider credentials, not Caracal SDK
   calls.
2. The agent does not know Caracal, Gateway, policy, provider IDs, or Console
   internals.
3. Caracal decides whether the app can receive Drive and Calendar tokens for this
   run.
4. The child process gets normal provider-native variables, so existing Google
   SDKs and HTTP clients can work without modification.
5. OpenAI remains the LLM used by the agent, matching real workflows where an
   agent combines enterprise context with model reasoning.

## Complete Console setup

Open Console:

```bash
caracal console
```

Then create or select these objects:

| Object | Purpose |
| --- | --- |
| Zone | Boundary that owns providers, resources, applications, and policies |
| Application | Workload identity used by `caracal run` to call STS |
| Google Drive provider | Provider that can return a Google OAuth access token with Drive read scope |
| Google Calendar provider | Provider that can return a Google OAuth access token with Calendar read scope |
| OpenAI provider | Provider or broker that can return an OpenAI-compatible credential |
| Google Drive resource | Resource identifier `resource://google-drive` attached to the Drive provider |
| Google Calendar resource | Resource identifier `resource://google-calendar` attached to the Calendar provider |
| OpenAI resource | Resource identifier `resource://openai` attached to the OpenAI provider |
| Policy | Allows the run application to request all three resources |

Use these concrete setup steps:

1. Create a zone, for example `Pied Piper Production`.
2. Create a managed confidential application, for example `PiperNet AI Research Agent`.
3. Save the one-time application client secret to the local auto-detected owner-only file:

   ```bash
   export CARACAL_ZONE_ID="zone_prod"
   export CARACAL_APPLICATION_ID="app_support_research_agent"
   CARACAL_RUNTIME_DIR="$HOME/.config/caracal/runtime/$CARACAL_ZONE_ID/$CARACAL_APPLICATION_ID"
   mkdir -p "$CARACAL_RUNTIME_DIR"
   install -m 600 /dev/null "$CARACAL_RUNTIME_DIR/client-secret"
   printf '%s' '<paste-one-time-client-secret-here>' > "$CARACAL_RUNTIME_DIR/client-secret"
   ```

4. Create the Google Drive provider:
   - Kind: OAuth/provider-token capable provider, or a Google Workspace token broker exposed to Caracal.
   - Runtime injection: enabled with `allow_runtime_injection = true`.
   - Scope: `https://www.googleapis.com/auth/drive.readonly`.
   - Token source: service-account-backed or brokered token flow for application-principal runs, or an existing delegated user grant.
5. Create the Google Calendar provider:
   - Kind: OAuth/provider-token capable provider, or a Google Workspace token broker exposed to Caracal.
   - Runtime injection: enabled with `allow_runtime_injection = true`.
   - Scope: `https://www.googleapis.com/auth/calendar.readonly`.
   - Token source: service-account-backed or brokered token flow for application-principal runs, or an existing delegated user grant.
6. Create the OpenAI provider:
   - Kind: API key, bearer token, or brokered provider.
   - Runtime injection: enabled with `allow_runtime_injection = true`.
   - Secret: store the OpenAI credential in the provider secret fields in Console, not in this repo.
7. Create the resources:

   | Name | Identifier | Upstream URL | Provider |
   | --- | --- | --- | --- |
   | Google Drive | `resource://google-drive` | `https://www.googleapis.com/drive/v3` | Google Drive provider |
   | Google Calendar | `resource://google-calendar` | `https://www.googleapis.com/calendar/v3` | Google Calendar provider |
   | OpenAI | `resource://openai` | `https://api.openai.com/v1` | OpenAI provider |

8. Create and activate a policy that allows the research-agent application to request all three resources.
9. Generate or copy the runtime profile values: zone ID, application ID, and the resource credential mapping. Add an STS URL only when you are not using the local default.

The Google providers should use the minimum scopes needed by the agent:

```text
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/calendar.readonly
```

The cleanest `caracal run` setup is a service/provider token path, such as a
Google Workspace token broker or service-account-backed OAuth provider, because
the run launcher authenticates as an application and does not contain a browser
consent loop.

For user-delegated Google OAuth, the user grants must already exist and be
available to STS through the normal Console or SDK grant flow before `caracal run`
can inject provider tokens. Do not treat `caracal run` as the place where OAuth
consent is created.

The OpenAI resource can use an API-key provider, bearer-token provider, or an
internal broker that exchanges a stored OpenAI secret for a short-lived scoped
credential. Raw OpenAI API keys are long-lived, so true provider-enforced expiry
requires a broker; without a broker, `caracal run` still prevents `.env` storage
and limits exposure to the child process lifetime.

## Local files to write

Write the local auto-detected credential manifest file. This file is not secret;
it maps Caracal resources to child-process environment variables:

```bash
export CARACAL_ZONE_ID="zone_prod"
export CARACAL_APPLICATION_ID="app_support_research_agent"
CARACAL_RUNTIME_DIR="$HOME/.config/caracal/runtime/$CARACAL_ZONE_ID/$CARACAL_APPLICATION_ID"
mkdir -p "$CARACAL_RUNTIME_DIR"
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

Write the runtime profile:

```bash
cat > ~/.config/caracal/research-agent/caracal.toml <<TOML
zone_id = "zone_prod"
application_id = "app_support_research_agent"
ttl_seconds = 900
continue_on_failure = false

[[credentials]]
env = "GOOGLE_DRIVE_ACCESS_TOKEN"
resource = "resource://google-drive"
credential_type = "provider_token"

[[credentials]]
env = "GOOGLE_CALENDAR_ACCESS_TOKEN"
resource = "resource://google-calendar"
credential_type = "provider_token"

[[credentials]]
env = "OPENAI_API_KEY"
resource = "resource://openai"
credential_type = "provider_token"
TOML
chmod 600 ~/.config/caracal/research-agent/caracal.toml
```

Replace `zone_id` and `application_id` with values from Console. Local dev/stable
runs auto-detect the client secret and JSON credential manifest under
`~/.config/caracal/runtime/<zone_id>/<application_id>/`. The credential
manifest and the inline `[[credentials]]` blocks show the same mapping;
use the TOML profile when you set `CARACAL_CONFIG`, or use the JSON manifest with
environment-only config. Cloud deployments, containers, and custom secret stores
use the runtime configuration docs for explicit secret-file and service URL paths.

## Environment example

The standalone env example is `env.example`:

```bash
export CARACAL_ZONE_ID="zone_prod"
export CARACAL_APPLICATION_ID="app_support_research_agent"
export CARACAL_RUN_TTL_SECONDS="900"
```

Recommended profile-based launch:

```bash
export CARACAL_CONFIG="$HOME/.config/caracal/research-agent/caracal.toml"
caracal run -- node agent.mjs
```

Environment-only launch:

```bash
export CARACAL_ZONE_ID="zone_prod"
export CARACAL_APPLICATION_ID="app_support_research_agent"
export CARACAL_RUN_TTL_SECONDS="900"

caracal run -- node agent.mjs
```

Do not export `GOOGLE_DRIVE_ACCESS_TOKEN`, `GOOGLE_CALENDAR_ACCESS_TOKEN`, or
`OPENAI_API_KEY` yourself. Those are the child-process variables Caracal injects
after STS authorizes the run.

## Runtime credential mapping reference

```json
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
```

That mapping is not a secret; it only says which resource should populate which
child-process env var. The bootstrap app identity is supplied to the launcher, not
to the child.

## Flow

```text
caracal run -- node agent.mjs
  |
  |-- loads the run identity and credential mapping
  |-- exchanges resource://google-drive at STS
  |     `-- receives a short-lived Google Drive OAuth access token
  |-- exchanges resource://google-calendar at STS
  |     `-- receives a short-lived Google Calendar OAuth access token
  |-- exchanges resource://openai at STS
  |     `-- receives an OpenAI-compatible credential
  |-- injects only GOOGLE_DRIVE_ACCESS_TOKEN, GOOGLE_CALENDAR_ACCESS_TOKEN, and OPENAI_API_KEY
  |-- strips Caracal admin/bootstrap secrets from the child env
  `-- starts node agent.mjs
        |
        |-- prompts the user for a question
        |-- searches Google Drive for relevant documents
        |-- reads Calendar events related to the question
        `-- asks GPT-5.4 mini to answer from that context
```

## Agent behavior

For each question, the agent:

1. Searches Google Drive for documents related to the question.
2. Exports matching Google Docs as text.
3. Reads recent and upcoming Calendar events related to the question.
4. Sends the question plus Drive and Calendar context to GPT-5.4 mini.
5. Prints the answer in the terminal.

Type `exit` or `quit` to end the session. Credentials disappear with the child
process environment when the process exits.

## Files

| File | Purpose |
| --- | --- |
| `agent.mjs` | A plain third-party interactive CLI agent launched by `caracal run` |
| `tests/agent.test.mjs` | Offline sanity tests for syntax, required env vars, and documentation consistency |
| `package.json` | Self-contained test command for this example |

## Local sanity checks

These checks do not contact Google, OpenAI, or Caracal:

```bash
pnpm test
```

They only verify that the agent syntax is valid, that direct execution fails
without injected credentials, and that the documentation references the real
provider resources.

## Constraints to account for

- Injected env vars are static for the process lifetime. Long-running agents must
  finish before expiry or be relaunched.
- Provider-native injection is opt-in per provider and still requires a normal
  policy allow decision for each resource.
- Google user-delegated OAuth requires an existing grant path; `caracal run` is
  not an OAuth consent UI.
- Raw API-key providers cannot be made truly provider-scoped by Caracal alone.
