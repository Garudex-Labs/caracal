# echoUpstream

## Scope
- Covers the self-contained echo upstream used to validate Gateway-to-upstream connectivity.

## Architecture Design
- Single zero-dependency Node HTTP service that echoes the forwarded request.
- Reports Gateway evidence (`X-Request-Id`, `Traceparent`, `X-Forwarded-*`, injected credential) and a `viaGateway` verdict in every echo response.
- Joins the external `caracalData` network so the Gateway resolves it by name.

## Required
- Must stay dependency-free and rely only on the Node standard library.
- Must keep the request handler pure and tested offline.
- Must redact credential headers (`Authorization`, `X-Caracal-Identity`, cookies) in echoed output.
- Must log one line per echoed request distinguishing brokered from direct calls.
- Must expose `/healthz` for container readiness.

## Forbidden
- Must not import Caracal package source or call live third-party services.
- Must not add framework or transport dependencies.
- Must not echo credential header values.

## Validation
- Run `node --test` from this directory.
