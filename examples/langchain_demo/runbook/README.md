# Runbook

## Goal

Run the LangChain demo through a real Caracal workspace with two execution modes:

- `mock`: deterministic external responses, placeholder credentials
- `real`: live providers and real credentials

Both modes use the same governed execution path.

## Steps

1. Start the demo app server:

```bash
uvicorn examples.langchain_demo.app:app --host 127.0.0.1 --port 8090
```

2. Configure Caracal runtime MCP server name `demo-upstream` pointing to `http://127.0.0.1:8090`.
3. Manually configure workspace, principals, providers, tools, mandates, and delegation.
4. Populate `examples/langchain_demo/demo_config.json`.
5. Run UI or CLI governed execution.

Full command-by-command setup is in `examples/langchain_demo/README.md`.

## Verification checks

In each run artifact, verify:

- role-specific mandates are used
- provider usage appears in timeline/usage summary
- authority validations include expected allow/deny decisions
- revocation check denies a post-revoke finance call
- acceptance checks pass against shared expected outcomes
