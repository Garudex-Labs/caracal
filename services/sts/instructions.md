# STS

## Scope
- Covers the token exchange service under caracal/services/sts/ only.

## Required
- Must use Go 1.26.
- Must listen on port 8080 only.
- Must read and follow caracal/plan/sts/plan.md before any change; check off tasks as completed.
- Must emit audit events to the caracal.audit.events Redis stream via AuditBuffer.
- Must DENY on partial OPA evaluation result (EvaluationStatus == "partial").
- Must use github.com/garudex-labs/caracal/packages/core/go/* for config, errors, crypto, and logging.
- Must sign JWTs with ES256 using the zone's signing key decrypted via ChaCha20-Poly1305.
- Must server-verify any caller-asserted agent_session_id against agent_sessions and bind it to the calling application before issuing a token.

## Forbidden
- Must not import from caracalEnterprise/.
- Must not embed Cedar or any policy engine other than OPA (github.com/open-policy-agent/opa).
- Must not store plaintext private keys, client secrets, or subject claims.
- Must not block the token-exchange path on audit emission or stream consumer errors.
- Must not add features beyond plan.md checkboxes.
