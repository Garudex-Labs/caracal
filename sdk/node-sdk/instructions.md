---
description: Apply when adding, editing, or reviewing the Node.js SDK.
applyTo: sdk/node-sdk/**
---

## Purpose
Node.js/TypeScript client SDK for interacting with the Caracal runtime API, AIS, and enterprise gateway.

## Rules
- `index.ts` is the public export root; all user-facing symbols must be re-exported from it.
- `client.ts` implements the base HTTP client; all API calls use it exclusively.
- `adapters/` contains transport adapters; one file per adapter type.
- `enterprise/` contains enterprise-only extensions; gate all enterprise paths.
- `ais.ts` handles AIS token acquisition only.
- `hooks.ts` defines lifecycle hooks; no business logic inside hooks.

## Constraints
- Forbidden: any `any` type annotations; all types must be explicit.
- Forbidden: storing credentials in module-level variables.
- Forbidden: importing from server packages.
- File names: `camelCase.ts`; class names: `PascalCase`; exported functions: `camelCase`.

## Imports
- Import from `node:*` built-ins, `caracal-sdk` internal modules, and declared `package.json` dependencies only.
- Never import from `../` outside the `sdk/node-sdk/src/` boundary.

## Error Handling
- All errors raise typed `CaracalError` subclasses exported from `errors.ts`.
- Never expose raw `fetch` or `axios` errors to callers.

## Security
- Credentials must not be stored as module-level constants or singletons.
- Server responses must be parsed against typed schemas; reject unknown fields.
