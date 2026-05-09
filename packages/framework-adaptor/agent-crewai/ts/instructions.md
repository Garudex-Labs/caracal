# agent-crewai/ts

## Scope
- Covers only the `@caracalai/agent-crewai` TS package under `packages/framework-adaptor/agent-crewai/ts/`.

## Required
- Must wrap the `@caracalai/sdk` primitives (`withAgent`, `withDelegation`, `current`, `toHeaders`) for CrewAI task execution.

## Forbidden
- Must not duplicate identity or token-exchange logic.
- Must not import `@caracalai/oauth` or `@caracalai/identity` directly; route through `@caracalai/sdk`.
