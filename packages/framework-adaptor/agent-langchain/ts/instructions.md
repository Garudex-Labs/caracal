# agent-langchain/ts

## Scope
- Covers only the `@caracalai/agent-langchain` TS package under `packages/framework-adaptor/agent-langchain/ts/`.

## Required
- Must wrap the `@caracalai/sdk` primitives (`withAgent`, `withDelegation`, `current`, `toHeaders`) for LangChain runnables, LangGraph nodes, and tool wrappers.

## Forbidden
- Must not duplicate identity or token-exchange logic.
- Must not import `@caracalai/oauth` or `@caracalai/identity` directly; route through `@caracalai/sdk`.
