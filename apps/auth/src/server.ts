// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// HTTP entrypoint that serves the web console SPA and the session-guarded backend-for-frontend.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { getMigrations } from 'better-auth/db/migration'
import { toNodeHandler } from 'better-auth/node'
import { bindTrace } from '@caracalai/core'
import { ShutdownRegistry, pathOnly } from '@caracalai/server-core'

import { auth } from './auth.ts'
import { handleAccount } from './account.ts'
import { loadConfig } from './config.ts'
import { closeAuthDatabase, pingAuthDatabase } from './database.ts'
import { handleConsole } from './console.ts'
import { enabledProviders } from './providers.ts'
import { logger } from './logger.ts'
import { serveStatic } from './static.ts'
import { applySecurityHeaders, CLIENT_IP_HEADER, clientIp, isCrossSiteWrite, method, requestId, traceFromRequest } from './security.ts'

const cfg = loadConfig()

async function ensureSchema(): Promise<void> {
  const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(auth.options)
  if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations()
}

// Cross-origin support is only needed for split deployments (a separate web origin, e.g. the
// local Vite dev server). The same-origin production image serves the SPA from this process, so
// the browser never makes a cross-origin call and the allowlist simply never matches a foreign
// Origin. Credentialed CORS requires echoing a single concrete origin, never a wildcard.
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (origin && cfg.webOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Vary', 'Origin')
  }
}

if (cfg.autoProvisionDatabase) {
  await ensureSchema()
}

const handler = toNodeHandler(auth)
const shutdown = new ShutdownRegistry({
  timeoutMs: 25_000,
  log: (level, msg, meta) => logger[level](msg, meta),
})

function notFound(res: ServerResponse): void {
  res.statusCode = 404
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: 'not_found' }))
}

function fail(res: ServerResponse, code: string): void {
  if (res.headersSent) return
  res.statusCode = 500
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: code }))
}

async function route(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const url = req.url ?? '/'

  // Liveness: the process is up. Cheap and dependency-free so the orchestrator never restarts a
  // pod for a transient dependency blip.
  if (url === '/health') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', service: 'caracal-auth' }))
    return
  }

  // Readiness: gate traffic on the session store and report not-ready while draining so a rolling
  // deploy removes the pod from rotation before in-flight requests are interrupted.
  if (url === '/ready') {
    if (shutdown.draining) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ status: 'draining' }))
      return
    }
    try {
      await pingAuthDatabase()
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ status: 'ready' }))
    } catch (err) {
      logger.error('readiness check failed', { id, err })
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ status: 'unavailable' }))
    }
    return
  }

  if (url === '/providers') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(enabledProviders(cfg)))
    return
  }

  // The release version of the web binary, shown in the console footer.
  if (url === '/version') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ version: cfg.version }))
    return
  }

  if (url.startsWith('/api/console')) {
    // CORS gates response reads, not the sending of credentialed requests. Cookie-authenticated
    // mutations must independently verify the browser Origin against the trusted allowlist, so a
    // foreign site cannot drive privileged control-plane writes with the operator's session.
    if (isCrossSiteWrite(req, cfg.webOrigins)) {
      res.statusCode = 403
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'cross_site_request_blocked' }))
      return
    }
    await handleConsole(req, res, { id })
    return
  }

  if (url === '/account') {
    // Account deletion is state-changing and cookie-authenticated, so it carries the same
    // cross-site write risk as the console proxy: verify the browser Origin independently of
    // cookie SameSite before mutating.
    if (isCrossSiteWrite(req, cfg.webOrigins)) {
      res.statusCode = 403
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'cross_site_request_blocked' }))
      return
    }
    await handleAccount(req, res)
    return
  }

  if (url.startsWith('/api/auth')) {
    // Password sign-up is a deployment capability, not a per-request decision: when it is off,
    // the endpoint is closed outright and allowlisted identities register through a configured
    // OAuth provider instead.
    if (!cfg.passwordSignup && method(req) === 'POST' && pathOnly(url) === '/api/auth/sign-up/email') {
      res.statusCode = 403
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'registration_not_permitted' }))
      return
    }
    await handler(req, res)
    return
  }

  // Same-origin SPA hosting. When a build is mounted, every non-API path resolves to a static
  // asset or falls back to the SPA shell so client-side deep links work. Without a build root the
  // process is a pure BFF (split deployment) and unmatched paths are 404 JSON.
  if (cfg.webRoot) {
    const outcome = await serveStatic(res, cfg.webRoot, url, String(req.headers['accept-encoding'] ?? ''), cfg.secureCookies)
    if (outcome.served) return
  }

  notFound(res)
}

const server = createServer((req, res) => {
  const id = requestId(req)
  // Stamp the resolved client address before any handling, always overwriting whatever arrived
  // on the wire, so Better Auth's per-IP rate limiting keys on an address the caller cannot
  // choose in every topology: the TCP peer when directly exposed, the trusted proxy's
  // x-forwarded-for entry when CARACAL_AUTH_TRUST_PROXY is set.
  req.headers[CLIENT_IP_HEADER] = clientIp(req, cfg.trustProxy)
  bindTrace(traceFromRequest(req))
  const startedAt = Date.now()

  applySecurityHeaders(res, { secure: cfg.secureCookies })
  res.setHeader('x-request-id', id)
  applyCors(req, res)

  if (method(req) === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  res.on('finish', () => {
    logger.info('request', {
      id,
      method: method(req),
      path: pathOnly(req.url ?? '/'),
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    })
  })

  route(req, res, id).catch((err) => {
    logger.error('request failed', { id, path: pathOnly(req.url ?? '/'), err })
    fail(res, 'internal_error')
  })
})

// Idle sockets must outlive the upstream/LB idle window so a pooled connection the edge is about
// to reuse is not closed underneath it, which otherwise surfaces as sporadic 502s.
server.keepAliveTimeout = 75_000
server.headersTimeout = 76_000

server.listen(cfg.port, cfg.host, () => {
  logger.info('listening', { baseURL: cfg.baseURL, host: cfg.host, port: cfg.port, web: Boolean(cfg.webRoot) })
})

// Drain in-flight requests before tearing down: stop accepting new connections and wait for the
// server to close, then release the database pool. Readiness already reports draining, so the LB
// removes this pod from rotation first. Steps run in reverse registration order.
shutdown.register('auth-db', () => closeAuthDatabase())
shutdown.register('http-server', () => new Promise<void>((resolve) => server.close(() => resolve())))
shutdown.install()
