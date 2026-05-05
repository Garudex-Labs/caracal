# api

## Scope
- Covers the control-plane API service under caracal/apps/api/ only.

## Required
- Must use TypeScript on Node 24 with Fastify 5.
- Must listen on port 3000 only.
- Must read and follow caracal/plan/api/plan.md before any change; check off tasks as completed.
- Must publish to caracal.policy.invalidate on policy set version activation.
- Must publish to caracal.sessions.revoke on grant revocation.
- Must validate all request inputs with Zod schemas before touching the database.
- Must use pg Pool for all database access; never expose raw connection strings in responses.

## Forbidden
- Must not import from caracalEnterprise/.
- Must not return plaintext secrets, credentials, or key material in any response.
- Must not accept Cedar policies; only Rego content.
- Must not add endpoints not listed in plan.md Phase 2.
- Must not duplicate config, error handling, or logging patterns already in caracal/shared/ts/.
