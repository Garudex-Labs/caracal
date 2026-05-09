# agent-crewai

## Scope
- Covers the per-language CrewAI adaptors that bind Caracal identity to CrewAI tasks and crews.

## Required
- Each language subdirectory must wrap the `@caracalai/sdk` primitives (`withAgent`, `withDelegation`, envelope helpers) around the CrewAI agent surface.

## Forbidden
- Must not duplicate identity, delegation, or token-exchange logic; route through `@caracalai/sdk`.
