# agent-langchain

## Scope
- Covers the per-language LangChain adaptors that bind Caracal identity to LangChain runnables and LangGraph nodes.

## Required
- Each language subdirectory must wrap the `@caracalai/sdk` primitives (`withAgent`, `withDelegation`, envelope helpers) around the LangChain agent surface.

## Forbidden
- Must not duplicate identity, delegation, or token-exchange logic; route through `@caracalai/sdk`.
