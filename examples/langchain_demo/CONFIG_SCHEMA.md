# Configuration Reference

This document describes the environment variables and optional JSON configuration for the Caracal Governed Demo.

## Environment Variables

These are the authoritative runtime controls for the demo. No JSON config file is required for standard operation.

| Variable | Default | Description |
|---|---|---|
| `CARACAL_DEMO_MODE` | `real` | Set to `mock` to use local handlers instead of a live provider |
| `CARACAL_DEMO_WORKSPACE` | (auto-detected) | Active workspace name; falls back to `ConfigManager` default |
| `CARACAL_DEMO_PORT` | `8090` | Port the demo FastAPI application listens on |
| `CARACAL_DEMO_LISTEN` | `0.0.0.0` | Bind address for the demo application |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis URL used for nonce management during principal spawn |
| `DATABASE_URL` | (from Caracal config) | PostgreSQL connection string |

## Optional JSON Configuration

A JSON file may be used to supply provider credentials and workspace overrides. Set `LANGCHAIN_DEMO_CONFIG` to the path of the file.

```json
{
  "_config_version": "4.0",
  "workspace": {
    "name": "demo-workspace"
  },
  "provider": {
    "name": "ops-api",
    "base_url": "https://ops-api.example.com",
    "credential_env": "OPS_API_TOKEN"
  }
}
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `_config_version` | string | No | Schema version marker |
| `workspace.name` | string | No | Workspace name; overrides `CARACAL_DEMO_WORKSPACE` |
| `provider.name` | string | No | Provider name registered in Caracal |
| `provider.base_url` | string | No | Base URL for real-mode outbound calls |
| `provider.credential_env` | string | No | Environment variable holding the provider credential |

## Demo Mode

`CARACAL_DEMO_MODE=mock` routes all tool calls through local handlers in `examples/langchain_demo/handlers.py`. Authority evaluation, mandate resolution, tool registry checks, and delegation enforcement all run normally — only the final outbound provider response is substituted.

`CARACAL_DEMO_MODE=real` (or unset) expects a live `ops-api` provider registered in the workspace. Tool calls traverse the full Caracal broker path to the real provider endpoint.

## Required Workspace State

Before the demo can run, the workspace must have:

- An active `workspace` created via `caracal workspace create`
- A `human`, `orchestrator`, `service`, and at least two `worker` principals — registered and activated
- A `GatewayProvider` row for `ops-api` with resource/action contracts populated
- Four tools registered: `demo:ops:incidents:read`, `demo:ops:deployments:read`, `demo:ops:logs:read`, `demo:ops:recommendation:write`
- At least one active policy and one active mandate for the orchestrator
- At least one delegation edge from orchestrator to a worker

Run `GET /api/preflight` or visit the demo UI to see the current readiness state and CLI fix instructions for each missing item.

