/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Offline tests for the echo upstream gateway-evidence reporting, redaction, and health endpoint.
*/

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { buildEchoResponse, createEchoServer, gatewayEvidence, redactHeaders } from '../server.mjs'

const brokeredHeaders = {
  authorization: 'Bearer caracal-token',
  'x-request-id': 'req-123',
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  'x-forwarded-for': '172.20.0.5',
  'x-forwarded-proto': 'http',
  'x-forwarded-host': 'localhost:8081',
}

test('gatewayEvidence reports the headers the Gateway stamps', () => {
  const evidence = gatewayEvidence(brokeredHeaders)
  assert.equal(evidence.requestId, 'req-123')
  assert.equal(evidence.forwardedFor, '172.20.0.5')
  assert.equal(evidence.forwardedProto, 'http')
  assert.equal(evidence.forwardedHost, 'localhost:8081')
  assert.equal(evidence.credentialInjected, true)
  assert.equal(evidence.identityForwarded, false)
  assert.match(evidence.traceparent, /^00-/)
})

test('redactHeaders hides credentials but keeps routing metadata', () => {
  const safe = redactHeaders({ ...brokeredHeaders, 'x-caracal-identity': 'jwt' })
  assert.equal(safe.authorization, '[redacted]')
  assert.equal(safe['x-caracal-identity'], '[redacted]')
  assert.equal(safe['x-request-id'], 'req-123')
})

test('buildEchoResponse confirms a brokered call', () => {
  const req = { method: 'POST', url: '/v1/orders', headers: brokeredHeaders }
  const out = buildEchoResponse(req, 'hello')
  assert.equal(out.service, 'echoUpstream')
  assert.equal(out.viaGateway, true)
  assert.match(out.message, /Brokered call confirmed/)
  assert.equal(out.request.method, 'POST')
  assert.equal(out.request.path, '/v1/orders')
  assert.equal(out.request.body, 'hello')
  assert.equal(out.request.headers.authorization, '[redacted]')
})

test('buildEchoResponse flags a direct call with empty body', () => {
  const req = { method: 'GET', url: '/', headers: { host: '127.0.0.1:8088' } }
  const out = buildEchoResponse(req, '')
  assert.equal(out.viaGateway, false)
  assert.match(out.message, /Direct call/)
  assert.equal(out.gateway.requestId, null)
  assert.equal(out.gateway.credentialInjected, false)
  assert.equal(out.request.body, null)
})

test('server echoes requests, logs them, and serves health', async () => {
  const lines = []
  const server = createEchoServer((line) => lines.push(line))
  server.listen(0)
  await once(server, 'listening')
  const port = server.address().port
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok' })

    const echoed = await fetch(`http://127.0.0.1:${port}/orders`, {
      method: 'POST',
      headers: brokeredHeaders,
      body: 'payload',
    })
    const json = await echoed.json()
    assert.equal(json.viaGateway, true)
    assert.equal(json.request.method, 'POST')
    assert.equal(json.request.path, '/orders')
    assert.equal(json.request.body, 'payload')
    assert.equal(json.request.headers.authorization, '[redacted]')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /\[gateway\] POST \/orders requestId=req-123/)
  } finally {
    server.close()
    await once(server, 'close')
  }
})
