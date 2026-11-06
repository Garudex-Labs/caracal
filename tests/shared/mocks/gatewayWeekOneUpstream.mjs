// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Controlled upstream for real-stack Gateway validation. Never returns credentials.
import { createServer } from 'node:http'

const counts = new Map()
const bodies = new Map()
let expectedKey = ''
let active = 0
let completed = 0
const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://upstream')
  if (url.pathname === '/ready' || url.pathname === '/health') return send(response, 200, { ok: true })
  if (url.pathname === '/__control') {
    if (request.method === 'POST') {
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (body.length > 8192) return send(response, 413, { error: 'too_large' })
      }
      const config = JSON.parse(body || '{}')
      if (typeof config.expectedKey === 'string') expectedKey = config.expectedKey
      if (config.reset) {
        counts.clear()
        bodies.clear()
        completed = 0
      }
    }
    return send(response, 200, { active, completed, requests: Object.fromEntries(counts), bodies: Object.fromEntries(bodies) })
  }
  const requestId = String(request.headers['x-request-id'] ?? 'missing')
  counts.set(requestId, (counts.get(requestId) ?? 0) + 1)
  active++
  response.once('close', () => {
    active--
    completed++
  })
  const credentialInjected = Boolean(expectedKey) && request.headers['x-week1-key'] === expectedKey
  const headersSanitized = !Object.keys(request.headers).some((name) => name.startsWith('x-caracal-'))
  if (url.pathname === '/slow') await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get('ms') ?? 1500)))
  if (url.pathname === '/stream' || url.pathname === '/quiet-stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: ready\n\n')
    if (url.pathname === '/quiet-stream') return
    const timer = setInterval(() => response.write('data: tick\n\n'), 100)
    response.once('close', () => clearInterval(timer))
    return
  }
  if (url.pathname === '/error') return send(response, 503, { upstreamError: true })
  if (url.pathname === '/redirect') {
    response.writeHead(302, { location: '/ok' })
    response.end()
    return
  }
  if (url.pathname === '/drop') {
    request.socket.destroy()
    return
  }
  if (request.method === 'POST') {
    let bytes = 0
    try {
      for await (const chunk of request) {
        bytes += chunk.length
        bodies.set(requestId, { bytes, complete: false })
      }
      bodies.set(requestId, { bytes, complete: true })
    } catch {
      response.destroy()
      return
    }
  }
  send(response, expectedKey && !credentialInjected ? 401 : 200, { ok: true, requestId, credentialInjected, headersSanitized })
})

server.listen(Number(process.env.PORT ?? 18080), '0.0.0.0', () => console.log('Week 1 controlled upstream ready'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
