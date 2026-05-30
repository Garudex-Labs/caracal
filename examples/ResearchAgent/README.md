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

Do not pass provider base URLs, model names, scopes, provider IDs, policies, or
resource mappings as command-line flags to the agent. Those belong in Caracal
Console and the runtime profile generated from Console.

The command is intentionally simple:

```bash
caracal run -- node agent.mjs
```

After launch, the agent opens an interactive terminal prompt:

```text
Caracal run research agent ready. Ask about Drive docs or Calendar events. Type "exit" to quit.
> What meetings do I have about the checkout incident, and what does Drive say caused it?
```

The model is hardcoded in the agent as **GPT-5.4 mini** (`gpt-5.4-mini`). The
provider endpoints are also fixed to the real public APIs:

| Provider | Endpoint used by the agent |
| --- | --- |
| Google APIs | `https://www.googleapis.com` |
| OpenAI | `https://api.openai.com/v1` |

If your deployment needs alternate endpoints, configure the providers and
resources in Console. Do not teach the external agent Caracal-specific routing.

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

## Provider setup model

Create or select these objects in Console:

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

## Runtime credential mapping

Put the run credential mapping in `CARACAL_RUN_CREDENTIALS_FILE` or
`CARACAL_RUN_CREDENTIALS`:

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

## Runtime profile shape

A real local profile has this shape:

```toml
zone_url = "https://sts.your-caracal.example"
zone_id = "zone_prod"
application_id = "app_support_research_agent"
app_client_secret_file = "/run/secrets/caracal-support-agent-secret"
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
```

Store the app client secret in an owner-only secret file. Do not put Google
tokens, refresh tokens, or OpenAI keys in this profile.

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
