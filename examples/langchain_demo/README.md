# Caracal LangChain Demo

This demo uses one governed execution path in both modes:

- Caracal SDK tool calls with explicit `mandate_id`
- Caracal MCP/runtime enforcement
- provider -> tool -> runtime routing from your registered workspace config
- delegation + revocation evidence driven by real mandates

The mode switch does not bypass Caracal. It only switches which provider/tool set is used:

- `mock`: deterministic external responses and placeholder credentials
- `real`: live external provider/API calls

## 1. Install dependencies

```bash
python -m pip install -r examples/langchain_demo/requirements.txt
```

## 2. Start the demo UI with uvicorn

```bash
uvicorn examples.langchain_demo.app:app --host 127.0.0.1 --port 8090
```

Open http://127.0.0.1:8090.

This server also hosts deterministic mock provider endpoints and the upstream MCP router at:

- `POST /tool/call`
- `POST /upstream/tool/call`

## 3. Configure Caracal runtime MCP forwarding

Your Caracal runtime must include a named MCP upstream server called `demo-upstream`.

Example environment variable for runtime startup:

```bash
export CARACAL_MCP_SERVERS='[{"name":"demo-upstream","url":"http://127.0.0.1:8090"}]'
```

## 4. Manual Caracal setup (CLI)

Do not automate these steps in code. Run them manually so the demo reflects real operator setup.

### 4.1 Create/select workspace

```bash
python -m caracal.cli.main workspace create langchain-demo
python -m caracal.cli.main workspace use langchain-demo
python -m caracal.cli.main workspace current
```

### 4.2 Create principals

```bash
python -m caracal.cli.main principal register --type human --name demo-issuer --email demo-issuer@example.com
python -m caracal.cli.main principal register --type orchestrator --name demo-orchestrator --email demo-orchestrator@example.com
python -m caracal.cli.main principal register --type worker --name demo-finance --email demo-finance@example.com
python -m caracal.cli.main principal register --type worker --name demo-ops --email demo-ops@example.com
python -m caracal.cli.main principal list
```

Record principal IDs for later steps.

### 4.3 Register providers (mock set)

All mock providers are registered exactly like real providers (base URL, auth scheme, resources, actions).

```bash
python -m caracal.cli.main provider add demo-openai-mock \
  --mode scoped --service-type ai --base-url http://127.0.0.1:8090/providers/mock/openai \
  --auth-scheme bearer --credential mock-openai-key \
  --resource chat.completions=MockOpenAIChat \
  --action chat.completions:invoke:POST:/v1/chat/completions

python -m caracal.cli.main provider add demo-gemini-mock \
  --mode scoped --service-type ai --base-url http://127.0.0.1:8090/providers/mock/gemini \
  --auth-scheme api-key --credential mock-gemini-key \
  --resource generateContent=MockGeminiGenerate \
  --action generateContent:invoke:POST:/v1beta/models

python -m caracal.cli.main provider add demo-finance-api-mock \
  --mode scoped --service-type application --base-url http://127.0.0.1:8090/providers/mock/finance \
  --auth-scheme api-key --credential mock-finance-key \
  --resource budgets=MockFinanceBudgets \
  --action budgets:read:GET:/v1/budget-summary

python -m caracal.cli.main provider add demo-ops-api-mock \
  --mode scoped --service-type application --base-url http://127.0.0.1:8090/providers/mock/ops \
  --auth-scheme api-key --credential mock-ops-key \
  --resource incidents=MockOpsIncidents \
  --action incidents:read:GET:/v1/incident-overview

python -m caracal.cli.main provider add demo-ticketing-api-mock \
  --mode scoped --service-type application --base-url http://127.0.0.1:8090/providers/mock/ticketing \
  --auth-scheme api-key --credential mock-ticketing-key \
  --resource tickets=MockTickets \
  --action tickets:create:POST:/v1/tickets

python -m caracal.cli.main provider add demo-control-plane \
  --mode scoped --service-type internal --base-url http://127.0.0.1:8090 \
  --auth-scheme none \
  --resource orchestrator=OrchestratorLogic \
  --action orchestrator:assemble:POST:/orchestrator/assemble
```

### 4.4 Register providers (real set)

Use real credentials and endpoints for real mode.

```bash
python -m caracal.cli.main provider add demo-openai-real \
  --mode scoped --service-type ai --base-url https://api.openai.com \
  --auth-scheme bearer --credential "$OPENAI_API_KEY" \
  --resource chat.completions=OpenAIChat \
  --action chat.completions:invoke:POST:/v1/chat/completions

python -m caracal.cli.main provider add demo-gemini-real \
  --mode scoped --service-type ai --base-url https://generativelanguage.googleapis.com \
  --auth-scheme api-key --credential "$GOOGLE_API_KEY" \
  --resource generateContent=GeminiGenerate \
  --action generateContent:invoke:POST:/v1beta/models

python -m caracal.cli.main provider add demo-finance-api-real \
  --mode scoped --service-type application --base-url "$LANGCHAIN_DEMO_REAL_FINANCE_BASE_URL" \
  --auth-scheme api-key --credential "$LANGCHAIN_DEMO_REAL_FINANCE_API_KEY" \
  --resource budgets=FinanceBudgets \
  --action budgets:read:GET:/v1/budget-summary

python -m caracal.cli.main provider add demo-ops-api-real \
  --mode scoped --service-type application --base-url "$LANGCHAIN_DEMO_REAL_OPS_BASE_URL" \
  --auth-scheme api-key --credential "$LANGCHAIN_DEMO_REAL_OPS_API_KEY" \
  --resource incidents=OpsIncidents \
  --action incidents:read:GET:/v1/incident-overview

python -m caracal.cli.main provider add demo-ticketing-api-real \
  --mode scoped --service-type application --base-url "$LANGCHAIN_DEMO_REAL_TICKETING_BASE_URL" \
  --auth-scheme api-key --credential "$LANGCHAIN_DEMO_REAL_TICKETING_API_KEY" \
  --resource tickets=Tickets \
  --action tickets:create:POST:/v1/tickets
```

### 4.5 Register tools

Replace `<ACTOR_PRINCIPAL_ID>` with a valid principal UUID (typically `demo-issuer`).

Mock tools:

```bash
python -m caracal.cli.main tool register --tool-id demo:employee:mock:finance:data --provider-name demo-finance-api-mock --resource-id budgets --action-id read --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:mock:finance:llm:openai --provider-name demo-openai-mock --resource-id chat.completions --action-id invoke --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:mock:finance:llm:gemini --provider-name demo-gemini-mock --resource-id generateContent --action-id invoke --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:mock:ops:data --provider-name demo-ops-api-mock --resource-id incidents --action-id read --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:mock:ops:llm:openai --provider-name demo-openai-mock --resource-id chat.completions --action-id invoke --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:mock:ops:llm:gemini --provider-name demo-gemini-mock --resource-id generateContent --action-id invoke --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:mock:ticket:create --provider-name demo-ticketing-api-mock --resource-id tickets --action-id create --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
```

Real tools:

```bash
python -m caracal.cli.main tool register --tool-id demo:employee:real:finance:data --provider-name demo-finance-api-real --resource-id budgets --action-id read --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:real:finance:llm:openai --provider-name demo-openai-real --resource-id chat.completions --action-id invoke --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:real:finance:llm:gemini --provider-name demo-gemini-real --resource-id generateContent --action-id invoke --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:real:ops:data --provider-name demo-ops-api-real --resource-id incidents --action-id read --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:real:ops:llm:openai --provider-name demo-openai-real --resource-id chat.completions --action-id invoke --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:real:ops:llm:gemini --provider-name demo-gemini-real --resource-id generateContent --action-id invoke --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
python -m caracal.cli.main tool register --tool-id demo:employee:real:ticket:create --provider-name demo-ticketing-api-real --resource-id tickets --action-id create --execution-mode mcp_forward --mcp-server-name demo-upstream --tool-type direct_api --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
```

Shared local logic tool:

```bash
python -m caracal.cli.main tool register --tool-id demo:employee:orchestrator:assemble --provider-name demo-control-plane --resource-id orchestrator --action-id assemble --execution-mode local --tool-type logic --handler-ref examples.langchain_demo.caracal.runtime_bridge:assemble_governed_briefing --workspace langchain-demo --actor-principal-id <ACTOR_PRINCIPAL_ID>
```

Validate tool mappings:

```bash
python -m caracal.cli.main tool preflight
```

### 4.6 Issue source mandate and delegated mandates

Issue source mandate from `demo-issuer` to `demo-orchestrator` with all tool IDs for a mode.

```bash
python -m caracal.cli.main authority mandate \
  --issuer-id <DEMO_ISSUER_PRINCIPAL_ID> \
  --subject-id <DEMO_ORCHESTRATOR_PRINCIPAL_ID> \
  --tool-id demo:employee:mock:finance:data \
  --tool-id demo:employee:mock:finance:llm:openai \
  --tool-id demo:employee:mock:finance:llm:gemini \
  --tool-id demo:employee:mock:ops:data \
  --tool-id demo:employee:mock:ops:llm:openai \
  --tool-id demo:employee:mock:ops:llm:gemini \
  --tool-id demo:employee:mock:ticket:create \
  --tool-id demo:employee:orchestrator:assemble \
  --validity-seconds 7200 --format json
```

Delegate to finance and ops principals with subset scopes:

```bash
python -m caracal.cli.main authority delegate --source-mandate-id <SOURCE_MANDATE_ID> --target-subject-id <DEMO_FINANCE_PRINCIPAL_ID> --resource-scope provider:demo-finance-api-mock:resource:budgets --resource-scope provider:demo-openai-mock:resource:chat.completions --resource-scope provider:demo-gemini-mock:resource:generateContent --action-scope provider:demo-finance-api-mock:action:read --action-scope provider:demo-openai-mock:action:invoke --action-scope provider:demo-gemini-mock:action:invoke --validity-seconds 3600 --format json

python -m caracal.cli.main authority delegate --source-mandate-id <SOURCE_MANDATE_ID> --target-subject-id <DEMO_OPS_PRINCIPAL_ID> --resource-scope provider:demo-ops-api-mock:resource:incidents --resource-scope provider:demo-openai-mock:resource:chat.completions --resource-scope provider:demo-gemini-mock:resource:generateContent --action-scope provider:demo-ops-api-mock:action:read --action-scope provider:demo-openai-mock:action:invoke --action-scope provider:demo-gemini-mock:action:invoke --validity-seconds 3600 --format json

python -m caracal.cli.main authority delegate --source-mandate-id <SOURCE_MANDATE_ID> --target-subject-id <DEMO_ORCHESTRATOR_PRINCIPAL_ID> --resource-scope provider:demo-control-plane:resource:orchestrator --resource-scope provider:demo-ticketing-api-mock:resource:tickets --action-scope provider:demo-control-plane:action:assemble --action-scope provider:demo-ticketing-api-mock:action:create --validity-seconds 3600 --format json
```

Repeat with the `real` provider scopes for real mode.

### 4.7 Create `demo_config.json`

Copy and fill:

```bash
cp examples/langchain_demo/demo_config.example.json examples/langchain_demo/demo_config.json
```

Set:

- `caracal.base_url`
- `caracal.api_key_env` (for example `CARACAL_API_KEY`)
- per-mode `source_mandate_id`
- per-mode `principal_ids`
- per-mode `mandates`
- per-mode `revoker_id`

Export the API key env var:

```bash
export CARACAL_API_KEY="<token used by the SDK in this demo app>"
```

## 5. TUI path (alternative)

Use the interactive TUI instead of raw CLI commands:

```bash
python -m caracal.flow.main
```

In the TUI, perform the same sequence:

1. Select/create workspace `langchain-demo`.
2. Create principals (`issuer`, `orchestrator`, `finance`, `ops`).
3. Add mock and real providers with matching resources/actions/auth scheme.
4. Register all tools with matching execution mode and provider bindings.
5. Issue source mandate and delegated mandates.
6. Record mandate IDs and principal IDs into `demo_config.json`.

## 6. Run the governed flow

UI: use the run controls at http://127.0.0.1:8090.

CLI one-shot:

```bash
python -m examples.langchain_demo.app --run-once --mode mock --provider-strategy mixed
python -m examples.langchain_demo.app --run-once --mode real --provider-strategy mixed
```

## Notes on credentials in mock mode

Mock provider credentials are placeholders by design.

- `mock-openai-key`
- `mock-gemini-key`
- `mock-finance-key`
- `mock-ops-key`
- `mock-ticketing-key`

You can override these defaults with env vars:

- `LANGCHAIN_DEMO_MOCK_OPENAI_KEY`
- `LANGCHAIN_DEMO_MOCK_GEMINI_KEY`
- `LANGCHAIN_DEMO_MOCK_FINANCE_KEY`
- `LANGCHAIN_DEMO_MOCK_OPS_KEY`
- `LANGCHAIN_DEMO_MOCK_TICKETING_KEY`
