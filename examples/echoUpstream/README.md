# Echo Upstream

A tiny test API you put behind Caracal to check that requests sent through the
Gateway really reach an upstream service.

It echoes every request back as JSON and answers one question: **did this call
come through the Gateway?**

- `"viaGateway": true` — the Gateway authorized and forwarded the call
- `"viaGateway": false` — the call hit the service directly

## Try it (30 seconds, no Caracal needed)

```bash
cd examples/echoUpstream
node server.mjs &
curl http://127.0.0.1:8088/v1/hello
```

You get `"viaGateway": false` — a direct, unprotected call. The rest of this
guide flips it to `true`.

## Full demo with Caracal

**1. Start it on the Caracal network** (after `caracal up`):

```bash
docker compose -f compose.yml up --build
```

**2. Protect it.** In the Console (`caracal console`), run guided setup and use
this upstream URL:

```text
http://echoUpstream:8088
```

**3. Call it through the Gateway** with the token and resource ID from guided
setup (the Console prints the exact command for you):

```bash
curl http://localhost:8081/v1/hello \
  -H "Authorization: Bearer $CARACAL_RESOURCE_PIPERNET_TOKEN" \
  -H "X-Caracal-Resource: resource://pipernet"
```

**4. Read the result:**

```json
{
  "viaGateway": true,
  "message": "Brokered call confirmed: the Caracal Gateway authorized this request and forwarded it to the protected upstream.",
  "gateway": {
    "requestId": "0af7651916cd43dd8448eb211c80319c",
    "credentialInjected": true
  }
}
```

- `viaGateway: true` — the request carried the Gateway's forwarding metadata
- `credentialInjected: true` — the Gateway supplied the credential; your client never held it
- `requestId` — paste it into Console **explain** to trace the policy decision

Credentials are always shown as `[redacted]` in echoed headers, and the server
logs each call as `[gateway]` or `[direct]` so you can watch traffic arrive.

## Test

```bash
node --test
```
