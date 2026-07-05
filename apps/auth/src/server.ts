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
import { consumeInvite, verifyInviteCode } from './bootstrapInvite.ts'
import { loadConfig } from './config.ts'
import { closeAuthDatabase, pingAuthDatabase } from './database.ts'
import { handleConsole } from './console.ts'
import { enabledProviders } from './providers.ts'
import { logger } from './logger.ts'
import { serveStatic } from './static.ts'
import { applySecurityHeaders, downstreamHeaders, isCrossSiteWrite, method, requestId, traceFromRequest } from './security.ts'

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

const MAX_SIGNUP_BODY_BYTES = 8192

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_SIGNUP_BODY_BYTES) {
        reject(new Error('request_body_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function rejectSignup(res: ServerResponse, status: number, code: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: code }))
}

// Password sign-up when it is not configured on: the single admission path is a one-time
// invite code minted by `caracal invite` on the stack host. The code is verified against the
// invite file's hash, stripped from the body, and the request is forwarded to Better Auth.
// A successful registration marks the email verified - the invite already proves an authority
// stronger than mailbox control - and consumes the invite so it can never admit a second account.
async function handleBootstrapSignup(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse((await readBody(req)).toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid_request')
    body = parsed as Record<string, unknown>
  } catch {
    rejectSignup(res, 400, 'invalid_request')
    return
  }
  const { invite_code: inviteCode, ...forwarded } = body
  const email = typeof forwarded.email === 'string' ? forwarded.email : ''
  if (typeof inviteCode !== 'string' || !verifyInviteCode(inviteCode, email, cfg)) {
    logger.warn('bootstrap sign-up rejected', { id, email })
    rejectSignup(res, 403, 'registration_not_permitted')
    return
  }

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key === 'content-length') continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }
  const response = await auth.handler(
    new Request(new URL(req.url ?? '/', cfg.baseURL), {
      method: 'POST',
      headers,
      body: JSON.stringify(forwarded),
    }),
  )
  const text = await response.text()

  if (response.ok) {
    // The registration is complete before the browser hears about it: mark the email verified
    // (through Better Auth's own adapter so schema mapping stays authoritative) and consume the
    // invite, so the operator's immediate follow-up sign-in never races either write.
    try {
      const userId = (JSON.parse(text) as { user?: { id?: string } }).user?.id
      if (userId) {
        const ctx = await auth.$context
        await ctx.internalAdapter.updateUser(userId, { emailVerified: true })
      }
      consumeInvite(cfg)
      logger.info('bootstrap operator registered', { id, email })
    } catch (err) {
      logger.error('bootstrap post-registration finalization failed', { id, email, err })
    }
  }

  res.statusCode = response.status
  for (const [key, value] of response.headers) {
    if (key !== 'set-cookie') res.setHeader(key, value)
  }
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) res.setHeader('set-cookie', cookies)
  res.end(text)
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
    // With password sign-up off, the sign-up endpoint answers only invite-code bootstrap
    // registrations; every other auth route flows to Better Auth untouched.
    if (!cfg.passwordSignup && method(req) === 'POST' && pathOnly(url) === '/api/auth/sign-up/email') {
      await handleBootstrapSignup(req, res, id)
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
