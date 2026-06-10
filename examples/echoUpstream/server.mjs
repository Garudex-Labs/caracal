/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Zero-dependency HTTP echo upstream that proves Gateway-brokered requests reach a protected target.
*/

import { createServer } from 'node:http'

const PORT = Number(process.env.ECHO_PORT ?? 8088)

// Credentials the Gateway injects must never be echoed back in full.
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-caracal-identity'])

export function redactHeaders(headers) {
  const safe = {}
  for (const [name, value] of Object.entries(headers)) {
    safe[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? '[redacted]' : value
  }
  return safe
}

// The Gateway stamps every upstream request with a request ID, a trace
// context, X-Forwarded-* metadata, and the brokered credential. Their
// presence is the proof that a call travelled through Caracal.
export function gatewayEvidence(headers) {
  return {
    requestId: headers['x-request-id'] ?? null,
    traceparent: headers['traceparent'] ?? null,
    forwardedFor: headers['x-forwarded-for'] ?? null,
    forwardedProto: headers['x-forwarded-proto'] ?? null,
    forwardedHost: headers['x-forwarded-host'] ?? null,
    credentialInjected: 'authorization' in headers,
    identityForwarded: 'x-caracal-identity' in headers,
  }
}

export function buildEchoResponse(req, body) {
  const evidence = gatewayEvidence(req.headers)
  const viaGateway = Boolean(evidence.requestId && evidence.forwardedFor)
  return {
    service: 'echoUpstream',
    viaGateway,
    message: viaGateway
      ? 'Brokered call confirmed: the Caracal Gateway authorized this request and forwarded it to the protected upstream.'
      : 'Direct call: this request bypassed the Gateway. Send it through the Gateway to see policy enforcement in action.',
    gateway: evidence,
    request: {
      method: req.method,
      path: req.url,
      headers: redactHeaders(req.headers),
      body: body.length > 0 ? body : null,
    },
    receivedAt: new Date().toISOString(),
  }
}

export function createEchoServer(log = () => {}) {
  return createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }
      const body = Buffer.concat(chunks).toString('utf8')
      const echo = buildEchoResponse(req, body)
      log(
        `${echo.viaGateway ? '[gateway]' : '[direct] '} ${req.method} ${req.url}` +
          ` requestId=${echo.gateway.requestId ?? '-'} from=${echo.gateway.forwardedFor ?? req.socket.remoteAddress}`,
      )
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(echo, null, 2) + '\n')
    })
  })
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const server = createEchoServer((line) => process.stdout.write(`${line}\n`))
  server.listen(PORT, () => {
    process.stdout.write(`echoUpstream listening on :${PORT}\n`)
    process.stdout.write(`Gateway target URL: http://echoUpstream:${PORT} | host URL: http://127.0.0.1:${PORT}\n`)
  })
}
