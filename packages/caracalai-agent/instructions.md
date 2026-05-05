# caracalai-agent

## Scope
- Covers only the `@caracalai/agent` package under `caracal/packages/caracalai-agent/`.

## Required
- Must implement A2A protocol: preserve subject token across hops; update clientId; scopes are subset only.
- Must route all token exchange through `@caracalai/oauth`.
- Must bind `AgentServiceConfig.url` as listen address, advertised registry address, and JWT `aud`.
- Must provide adapters for CrewAI, LangChain, and custom base class only.

## Forbidden
- Must not import from `caracalEnterprise/`.
- Must not allow scope escalation across hops.
- Must not log plaintext tokens.
- Must not add framework adapters beyond CrewAI, LangChain, and custom.
