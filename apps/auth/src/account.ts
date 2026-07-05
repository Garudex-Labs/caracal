// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Account lifecycle endpoint for deleting the authenticated Community Edition identity.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { auth } from './auth.ts'
import { enforceDenial, resolveAccess } from './allowlist.ts'
import { loadConfig } from './config.ts'

const cfg = loadConfig()

const MAX_BODY_BYTES = 4096

function toWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }
  return headers
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
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

async function readJson(req: IncomingMessage): Promise<{ confirmEmail?: unknown }> {
  const body = await readBody(req)
  if (body.length === 0) return {}
  const parsed = JSON.parse(body.toString('utf8')) as unknown
  return parsed && typeof parsed === 'object' ? parsed : {}
}

export async function handleAccount(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.url !== '/account') return false
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE')
    sendJson(res, 405, { error: 'method_not_allowed' })
    return true
  }

  const session = await auth.api.getSession({ headers: toWebHeaders(req) })
  if (!session) {
    sendJson(res, 401, { error: 'unauthenticated' })
    return true
  }

  // Denials are enforced here exactly as on the console proxy: a lock keeps the account's data
  // by contract (so self-deletion is refused), a removal erases the auth records, and the
  // response code never reveals which case applied.
  const access = resolveAccess(session.user.email, cfg)
  if (access !== 'allowed') {
    await enforceDenial(await auth.$context, access, { id: session.user.id, email: session.user.email })
    sendJson(res, 403, { error: 'access_denied' })
    return true
  }

  let body: { confirmEmail?: unknown }
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: 'invalid_request' })
    return true
  }

  const email = session.user.email
  if (typeof body.confirmEmail !== 'string' || body.confirmEmail.trim() !== email) {
    sendJson(res, 400, { error: 'email_confirmation_required' })
    return true
  }

  // Delete through Better Auth's internal adapter so the cascade (sessions, accounts,
  // user) runs identically on PostgreSQL and SQLite. Pending verification rows are keyed
  // by email identifier rather than user id, so clear them explicitly.
  const ctx = await auth.$context
  await ctx.internalAdapter.deleteUser(session.user.id)
  await ctx.adapter.deleteMany({
    model: 'verification',
    where: [{ field: 'identifier', value: email }],
  })

  res.statusCode = 204
  res.setHeader('Cache-Control', 'no-store')
  res.end()
  return true
}
