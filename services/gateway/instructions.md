# gateway

## Scope
- Covers the MCP reverse proxy service under caracal/services/gateway/ only.

## Required
- Must use Go 1.26 with net/http only; no external HTTP framework.
- Must listen on port 8081 only; loadConfig must reject any other PORT.
- Must perform a fresh STS exchange on every proxied request.
- Must use github.com/garudex-labs/caracal/shared/* for config, errors, and logging.
- Must require STS_URL (https) and TLS_CERT_FILE+TLS_KEY_FILE; only INSECURE_STS=true and INSECURE_HTTP=true may relax these in dev.
- Must validate every STS-supplied upstream through upstreamGuard; the upstream Transport must use guard.SafeDialContext to re-validate at connect time.
- Must strip RFC 7230 hop-by-hop headers and X-Caracal-* routing headers before forwarding upstream.
- Must replace the inbound Authorization header with the STS-issued bearer token.
- Must enforce MaxRequestBytes via http.MaxBytesReader.
- Must flush after every chunk so SSE/streaming responses are not buffered.
- Must propagate X-Request-Id end to end (generate UUIDv4 if missing/invalid).
- Must shut down via http.Server.Shutdown bounded by shutdownGrace.

## Forbidden
- Must not import from caracalEnterprise/.
- Must not cache STS tokens or upstream responses at any layer.
- Must not log plaintext bearer tokens; use tokenFingerprint for correlation.
- Must not retry STS exchanges or upstream calls (fail-closed).
- Must not forward to private/loopback/link-local/CGNAT/metadata IPs unless ALLOW_PRIVATE_UPSTREAMS=true.

## Environment Variables
- Required: STS_URL.
- TLS: TLS_CERT_FILE, TLS_KEY_FILE (both or neither).
- Timeouts: STS_TIMEOUT, UPSTREAM_TIMEOUT, READ_HEADER_TIMEOUT, READ_TIMEOUT, WRITE_TIMEOUT, IDLE_TIMEOUT.
- Limits: MAX_REQUEST_BYTES.
- SSRF: UPSTREAM_HOST_ALLOWLIST (CSV), ALLOW_PRIVATE_UPSTREAMS.
- Dev escape hatches: INSECURE_HTTP, INSECURE_STS.
- Misc: PORT (must equal 8081), LOG_LEVEL.
