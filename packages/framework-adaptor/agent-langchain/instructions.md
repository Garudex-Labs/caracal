# agent-langchain

## Scope
- Covers the per-language LangChain adaptors for the Caracal agent runtime.

## Required
- Each language subdirectory must wrap the `agent-core` runtime around the LangChain agent surface.

## Forbidden
- Must not duplicate runtime logic that belongs in `agent-core`.
