// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Admin authentication: DB-backed hashed bearer tokens with per-actor identity and zone scope.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { timingSafeEqual } from 'node:crypto'
import { sha256 } from '@caracalai/core'
import { v7 as uuidv7 } from 'uuid'
import type { DB } from './db.js'
import type { RedisClient } from './redis.js'
import { redisMinuteBucket } from './redis.js'
import { hashAdminToken, verifyAdminTokenHash } from './hash-secret.js'
import { bindRequestZoneScope, GLOBAL_ZONE_SCOPE } from './zone-context.js'

type AdminScope = 'global' | 'zone'

export interface Actor {
  id: string
  name: string
  scope: AdminScope
  zoneId: string | null
}

interface AdminTokenRow {
  id: string
  name: string
  scope: AdminScope
  zone_id: string | null
  token_sha256: Buffer
  token_hash: string | null
  revoked_at: Date | null
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor
  }
}

const BEARER_PREFIX = 'Bearer '
const MAX_ADMIN_BEARER_BYTES = 4096
const INVALID_ZONE_ID = '\u0000invalid-zone'

function bytesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

function extractBearer(req: FastifyRequest): string | null {
  const auth = req.headers.authorization
  if (typeof auth !== 'string' || !auth.startsWith(BEARER_PREFIX)) return null
  const token = auth.slice(BEARER_PREFIX.length).trim()
  return token.length > 0 && token.length <= MAX_ADMIN_BEARER_BYTES ? token : null
}

function zoneFromUrl(url: string): string {
  const match = url.match(/^\/v1\/zones\/([^/?]+)/)
  if (!match) return INVALID_ZONE_ID
  try {
    return decodeURIComponent(match[1])
  } catch {
    return INVALID_ZONE_ID
  }
}

function isGlobalReadPath(method: string, url: string): boolean {
  const path = url.split('?')[0]
  if (path === '/v1/policies/validate') return method === 'POST'
  if (path === '/v1/policy-templates' || path.startsWith('/v1/policy-templates/')) {
    return method === 'GET' || method === 'HEAD'
  }
  return false
}

function isPublicOAuthCallback(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  const path = url.split('?')[0]
  return /^\/v1\/zones\/[^/]+\/provider-grants\/oauth\/callback$/.test(path)
}

export async function lookupAdminToken(db: DB, plaintext: string): Promise<Actor | null> {
  const digest = sha256(plaintext)
  const { rows } = await db.query<AdminTokenRow>(
    `SELECT id, name, scope, zone_id, token_sha256, token_hash, revoked_at
     FROM admin_tokens
     WHERE token_sha256 = $1 AND revoked_at IS NULL
     LIMIT 1`,
    [digest],
  )
  const row = rows[0]
  if (!row) return null
  if (!bytesEqual(row.token_sha256, digest)) return null
  if (!row.token_hash || !(await verifyAdminTokenHash(plaintext, row.token_hash))) return null
  return { id: row.id, name: row.name, scope: row.scope, zoneId: row.zone_id }
}

async function touchLastUsed(db: DB, tokenId: string): Promise<void> {
  await db.query(
    `UPDATE admin_tokens SET last_used_at = now() WHERE id = $1`,
    [tokenId],
  )
}

async function shouldTouchLastUsed(
  redis: RedisClient | null,
  tokenId: string,
  debounceSec: number,
): Promise<boolean> {
  if (!redis || debounceSec <= 0) return true
  const ok = await redis.set(`api:admin_token_touched:${tokenId}`, '1', 'EX', debounceSec, 'NX')
  return ok === 'OK'
}

async function recordAuthFailure(
  redis: RedisClient | null,
  ip: string,
  limitPerMin: number,
): Promise<boolean> {
  if (!redis || limitPerMin <= 0) return false
  const minute = await redisMinuteBucket(redis)
  const key = `api:admin_auth_fail:${ip}:${minute}`
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, 90)
  return count > limitPerMin
}

interface SeedOptions {
  envToken: string | null
  log: (msg: string) => void
}

export async function seedBootstrapAdminToken(db: DB, opts: SeedOptions): Promise<void> {
  if (!opts.envToken) return
  const digest = sha256(opts.envToken)
  const { rows } = await db.query<{ id: string; token_hash: string | null }>(
    `SELECT id, token_hash FROM admin_tokens WHERE token_sha256 = $1 LIMIT 1`,
    [digest],
  )
  const row = rows[0]
  if (row?.token_hash) {
    await revokeStaleBootstrapTokens(db, digest)
    return
  }
  const tokenHash = await hashAdminToken(opts.envToken)
  if (row) {
    await db.query(
      `UPDATE admin_tokens SET token_hash = $1 WHERE id = $2 AND token_hash IS NULL`,
      [tokenHash, row.id],
    )
    await revokeStaleBootstrapTokens(db, digest)
    opts.log(`seeded bootstrap admin token verifier id=${row.id}`)
    return
  }
  const id = uuidv7()
  await db.query(
    `INSERT INTO admin_tokens (id, name, token_sha256, token_hash, scope, zone_id, created_by)
     VALUES ($1, 'bootstrap', $2, $3, 'global', NULL, 'env-bootstrap')`,
    [id, digest, tokenHash],
  )
  await revokeStaleBootstrapTokens(db, digest)
  opts.log(`seeded bootstrap admin token id=${id}`)
}

async function revokeStaleBootstrapTokens(db: DB, activeDigest: Buffer): Promise<void> {
  await db.query(
    `UPDATE admin_tokens
     SET revoked_at = now()
     WHERE created_by = 'env-bootstrap'
       AND revoked_at IS NULL
       AND token_sha256 <> $1`,
    [activeDigest],
  )
}

export interface AuthPluginOptions {
  db: DB
  redis?: RedisClient
  protectedPrefix?: string
  authFailLimitPerMin?: number
  lastUsedDebounceSec?: number
}

const adminAuthImpl: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const prefix = opts.protectedPrefix ?? '/v1/'
  const redis = opts.redis ?? null
  const failLimit = opts.authFailLimitPerMin ?? 0
  const debounceSec = opts.lastUsedDebounceSec ?? 0

  fastify.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith(prefix)) return
    if (isPublicOAuthCallback(req.method, req.url)) return

    const bearer = extractBearer(req)
    if (!bearer) {
      if (await recordAuthFailure(redis, req.ip, failLimit)) {
        return reply.code(429).send({ error: 'rate_limited' })
      }
      return reply.code(401).send({ error: 'invalid_admin_token' })
    }

    const actor = await lookupAdminToken(opts.db, bearer)
    if (!actor) {
      if (await recordAuthFailure(redis, req.ip, failLimit)) {
        return reply.code(429).send({ error: 'rate_limited' })
      }
      return reply.code(401).send({ error: 'invalid_admin_token' })
    }

    if (actor.scope === 'zone') {
      if (!isGlobalReadPath(req.method, req.url)) {
        const reqZone = zoneFromUrl(req.url)
        if (reqZone === INVALID_ZONE_ID || reqZone !== actor.zoneId) {
          return reply.code(403).send({ error: 'admin_token_zone_mismatch' })
        }
      }
    }

    req.actor = actor
    bindRequestZoneScope(actor.scope === 'zone' && actor.zoneId ? actor.zoneId : GLOBAL_ZONE_SCOPE)
    if (await shouldTouchLastUsed(redis, actor.id, debounceSec)) {
      touchLastUsed(opts.db, actor.id).catch((err) => {
        req.log.warn({ err, tokenId: actor.id }, 'failed to update admin_tokens.last_used_at')
      })
    }
  })
}

export const adminAuthPlugin = fp(adminAuthImpl, { name: 'admin-auth' })
