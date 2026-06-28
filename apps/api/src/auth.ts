// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Admin authentication: DB-backed hashed bearer tokens with per-actor identity and zone scope.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { timingSafeEqual } from 'node:crypto'
import { sha256, deriveConsoleReadToken, deriveConsoleWriteToken } from '@caracalai/core'
import { v7 as uuidv7 } from 'uuid'
import type { DB } from './db.js'
import type { RedisClient } from './redis.js'
import { redisMinuteBucket } from './redis.js'
import { hashAdminToken, verifyAdminTokenHash } from './hash-secret.js'
import { bindRequestZoneScope, GLOBAL_ZONE_SCOPE } from './zone-context.js'
import { isInternalProvisioner, isReservedZone } from './reserved-namespace.js'

type AdminScope = 'global' | 'zone'
type AdminCapability = 'read' | 'write'

export interface Actor {
  id: string
  name: string
  scope: AdminScope
  // Whether the token may mutate state at the API. A read-capability token is denied any
  // mutating request at the auth choke point, so a least-privilege admin credential cannot
  // change state even on a route that does not check it. Defaults to write for every existing
  // and bootstrap token, so the capability only ever narrows authority, never widens it.
  capability: AdminCapability
  zoneId: string | null
  // The seed marker the token was provisioned under. It classifies the credential — bootstrap,
  // a derived Console operational token, or an operator-minted token — so the admin-token
  // management surface can refuse the derived operational tokens without trusting URL heuristics.
  createdBy: string
}

interface AdminTokenRow {
  id: string
  name: string
  scope: AdminScope
  capability: AdminCapability
  zone_id: string | null
  created_by: string
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

function isControlInvoke(method: string, url: string): boolean {
  if (method !== 'POST') return false
  return url.split('?')[0] === '/v1/control/invoke'
}

// Whether a request only reads state. GET and HEAD are reads; the read-but-POST exceptions
// (policy validation) are the same ones a zone token may run cross-zone, so the existing
// classifier names them. A read-capability token is allowed exactly these and denied
// everything else, so the capability gate is a single, complete boundary that does not depend
// on each route re-checking it.
function isReadOnlyRequest(method: string, url: string): boolean {
  if (method === 'GET' || method === 'HEAD') return true
  return isGlobalReadPath(method, url)
}

export async function lookupAdminToken(db: DB, plaintext: string): Promise<Actor | null> {
  const digest = sha256(plaintext)
  const { rows } = await db.query<AdminTokenRow>(
    `SELECT id, name, scope, capability, zone_id, created_by, token_sha256, token_hash, revoked_at
     FROM admin_tokens
     WHERE token_sha256 = $1 AND revoked_at IS NULL
     LIMIT 1`,
    [digest],
  )
  const row = rows[0]
  if (!row) return null
  if (!bytesEqual(row.token_sha256, digest)) return null
  if (!row.token_hash || !(await verifyAdminTokenHash(plaintext, row.token_hash))) return null
  return { id: row.id, name: row.name, scope: row.scope, capability: row.capability, zoneId: row.zone_id, createdBy: row.created_by }
}

async function touchLastUsed(db: DB, tokenId: string): Promise<void> {
  await db.query(`UPDATE admin_tokens SET last_used_at = now() WHERE id = $1`, [tokenId])
}

async function shouldTouchLastUsed(redis: RedisClient | null, tokenId: string, debounceSec: number): Promise<boolean> {
  if (!redis || debounceSec <= 0) return true
  const ok = await redis.set(`api:admin_token_touched:${tokenId}`, '1', 'EX', debounceSec, 'NX')
  return ok === 'OK'
}

async function recordAuthFailure(redis: RedisClient | null, ip: string, limitPerMin: number): Promise<boolean> {
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
    await db.query(`UPDATE admin_tokens SET token_hash = $1 WHERE id = $2 AND token_hash IS NULL`, [tokenHash, row.id])
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

// The reserved names and creators of the Console BFF's derived admin tokens, so each seeder can
// reconcile exactly its own row without touching operator-minted tokens or the other derived
// token. The creators are distinct so the per-creator stale-revocation of one token type can
// never revoke the other.
const CONSOLE_READ_TOKEN_NAME = 'console-read-only'
const CONSOLE_READ_TOKEN_CREATED_BY = 'env-derived'
const CONSOLE_WRITE_TOKEN_NAME = 'console-write'
const CONSOLE_WRITE_TOKEN_CREATED_BY = 'env-derived-write'

// Both derived Console creators share this prefix, so a single predicate recognises every derived
// Console credential regardless of capability. Derived tokens are strictly operational, so they are
// denied the admin-token management surface: one must never mint a fresh, non-derived admin token
// (an escalation that would outlive bootstrap rotation) or revoke the break-glass credential.
const DERIVED_CONSOLE_CREATED_BY_PREFIX = 'env-derived'

export function isDerivedConsoleActor(actor: Actor): boolean {
  return actor.createdBy.startsWith(DERIVED_CONSOLE_CREATED_BY_PREFIX)
}

// Provisions a Console BFF admin token derived deterministically from the deployment admin
// token. The value is deterministic, so this is idempotent — the same admin token yields the
// same row every run — and needs no secret file or minting round-trip, which keeps every BFF
// replica in agreement. Rotating the admin token rotates the derived token and supersedes the
// prior row, which is then revoked (scoped to this token's own creator) so a stale derived
// credential never lingers and the two derived tokens never revoke each other.
async function seedDerivedConsoleToken(
  db: DB,
  derived: string,
  meta: { name: string; capability: AdminCapability; createdBy: string; logLabel: string },
  log: (msg: string) => void,
): Promise<void> {
  const digest = sha256(derived)
  const { rows } = await db.query<{ token_hash: string | null }>(`SELECT token_hash FROM admin_tokens WHERE token_sha256 = $1 LIMIT 1`, [
    digest,
  ])
  if (!rows[0]) {
    const tokenHash = await hashAdminToken(derived)
    await db.query(
      `INSERT INTO admin_tokens (id, name, token_sha256, token_hash, scope, capability, zone_id, created_by)
       VALUES ($1, $2, $3, $4, 'global', $5, NULL, $6)`,
      [uuidv7(), meta.name, digest, tokenHash, meta.capability, meta.createdBy],
    )
    log(meta.logLabel)
  } else if (!rows[0].token_hash) {
    await db.query(`UPDATE admin_tokens SET token_hash = $1 WHERE token_sha256 = $2 AND token_hash IS NULL`, [
      await hashAdminToken(derived),
      digest,
    ])
  }
  await db.query(
    `UPDATE admin_tokens
     SET revoked_at = now()
     WHERE created_by = $1
       AND revoked_at IS NULL
       AND token_sha256 <> $2`,
    [meta.createdBy, digest],
  )
}

// Provisions the Console BFF's read-only admin token: a global, read-capability credential the
// BFF presents on read traffic so the shared god token is no longer the credential behind the
// bulk of console requests. A read token cannot mutate state at the API, so a fault confined to
// the read proxy path can never write.
export async function seedConsoleReadToken(db: DB, opts: SeedOptions): Promise<void> {
  if (!opts.envToken) return
  await seedDerivedConsoleToken(
    db,
    deriveConsoleReadToken(opts.envToken),
    {
      name: CONSOLE_READ_TOKEN_NAME,
      capability: 'read',
      createdBy: CONSOLE_READ_TOKEN_CREATED_BY,
      logLabel: 'seeded console read-only admin token',
    },
    opts.log,
  )
}

// Provisions the Console BFF's write admin token: a global, write-capability credential the BFF
// presents on mutating traffic so the deployment admin token is reserved as a break-glass
// fallback rather than the everyday operational credential. It is independently revocable from
// the bootstrap admin token, yet derivable only by a holder of that token, so it grants nothing
// new while taking the bootstrap secret off the BFF's normal write path.
export async function seedConsoleWriteToken(db: DB, opts: SeedOptions): Promise<void> {
  if (!opts.envToken) return
  await seedDerivedConsoleToken(
    db,
    deriveConsoleWriteToken(opts.envToken),
    {
      name: CONSOLE_WRITE_TOKEN_NAME,
      capability: 'write',
      createdBy: CONSOLE_WRITE_TOKEN_CREATED_BY,
      logLabel: 'seeded console write admin token',
    },
    opts.log,
  )
}

export interface AuthPluginOptions {
  db: DB
  redis?: RedisClient
  protectedPrefix?: string
  authFailLimitPerMin?: number
  lastUsedDebounceSec?: number
  verifyCacheTtlMs?: number
}

const adminAuthImpl: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const prefix = opts.protectedPrefix ?? '/v1/'
  const redis = opts.redis ?? null
  const failLimit = opts.authFailLimitPerMin ?? 0
  const debounceSec = opts.lastUsedDebounceSec ?? 0

  // The admin token is a static, high-entropy secret, yet every /v1/ request re-runs an
  // Argon2id verification (64 MB, timeCost 3) plus a Postgres lookup. A single page fires
  // many parallel admin requests, so that cost dominates latency even with little data.
  // Successful verifications are therefore cached by token digest for a short window and
  // concurrent verifications are de-duplicated onto one promise. The TTL is short so a
  // revoked token (revoked_at filtered by lookupAdminToken) stops working within seconds,
  // and only successes are cached, so failed/brute-force attempts still pay full cost and
  // remain rate-limited. The cache is scoped to this plugin registration for test isolation.
  const verifyTtlMs = opts.verifyCacheTtlMs ?? 5_000
  const verifyCacheMax = 512
  const verifiedCache = new Map<string, { at: number; actor: Actor }>()
  const verifyInFlight = new Map<string, Promise<Actor | null>>()

  async function verifyAdminToken(bearer: string): Promise<Actor | null> {
    if (verifyTtlMs <= 0) return lookupAdminToken(opts.db, bearer)
    const key = sha256(bearer).toString('base64')
    const now = Date.now()
    const cached = verifiedCache.get(key)
    if (cached && now - cached.at < verifyTtlMs) return cached.actor
    const existing = verifyInFlight.get(key)
    if (existing) return existing
    const lookup = lookupAdminToken(opts.db, bearer)
      .then((actor) => {
        if (actor) {
          if (verifiedCache.size >= verifyCacheMax) {
            for (const k of verifiedCache.keys()) {
              verifiedCache.delete(k)
              if (verifiedCache.size < verifyCacheMax) break
            }
          }
          verifiedCache.set(key, { at: Date.now(), actor })
        }
        return actor
      })
      .finally(() => {
        verifyInFlight.delete(key)
      })
    verifyInFlight.set(key, lookup)
    return lookup
  }

  // Whether a zone id names the reserved system zone, cached briefly by id. The reserved
  // status of a zone never changes, so a short TTL keeps the mutation gate off the hot path
  // while still tolerating the zone being provisioned after the process starts. A miss caches
  // false too; ids are uuids, so a later real zone never collides with a cached negative.
  const reservedZoneTtlMs = 30_000
  const reservedZoneCacheMax = 1024
  const reservedZoneCache = new Map<string, { at: number; reserved: boolean }>()

  async function isReservedZoneId(zoneId: string): Promise<boolean> {
    const now = Date.now()
    const cached = reservedZoneCache.get(zoneId)
    if (cached && now - cached.at < reservedZoneTtlMs) return cached.reserved
    const { rows } = await opts.db.query<{ name: string; slug: string }>(`SELECT name, slug FROM zones WHERE id = $1 LIMIT 1`, [zoneId])
    const reserved = rows[0] ? isReservedZone(rows[0]) : false
    if (reservedZoneCache.size >= reservedZoneCacheMax) reservedZoneCache.clear()
    reservedZoneCache.set(zoneId, { at: now, reserved })
    return reserved
  }

  fastify.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith(prefix)) return
    if (isPublicOAuthCallback(req.method, req.url)) return
    if (isControlInvoke(req.method, req.url)) return

    const bearer = extractBearer(req)
    if (!bearer) {
      if (await recordAuthFailure(redis, req.ip, failLimit)) {
        return reply.code(429).send({ error: 'rate_limited' })
      }
      return reply.code(401).send({ error: 'invalid_admin_token' })
    }

    const actor = await verifyAdminToken(bearer)
    if (!actor) {
      if (await recordAuthFailure(redis, req.ip, failLimit)) {
        return reply.code(429).send({ error: 'rate_limited' })
      }
      return reply.code(401).send({ error: 'invalid_admin_token' })
    }

    // A read-capability token may never mutate state. The check sits at the single auth choke
    // point ahead of every admin route, so a read-only credential is denied any write even on
    // a route that does not inspect the capability itself — defense in depth, not per-route
    // trust. The control invoke path returned earlier and carries its own scope enforcement,
    // so this gate governs only the admin route surface.
    if (actor.capability === 'read' && !isReadOnlyRequest(req.method, req.url)) {
      return reply.code(403).send({ error: 'admin_token_read_only' })
    }

    if (actor.scope === 'zone') {
      if (!isGlobalReadPath(req.method, req.url)) {
        const reqZone = zoneFromUrl(req.url)
        if (reqZone === INVALID_ZONE_ID || reqZone !== actor.zoneId) {
          return reply.code(403).send({ error: 'admin_token_zone_mismatch' })
        }
      }
    }

    // The reserved system zone is provisioned and owned by Caracal's own bootstrap identity.
    // Every other actor may read it for transparency but may never mutate it, so the
    // platform's internal control objects cannot be altered through the admin API or the
    // Console — the security boundary that backs the Console's read-only system-zone view. The
    // internal provisioner is exempt because it is the identity that seals the zone. Only a
    // mutating request that targets a specific zone is checked; reads and non-zone paths skip
    // the lookup entirely.
    if (!isReadOnlyRequest(req.method, req.url) && !isInternalProvisioner(actor)) {
      const reqZone = zoneFromUrl(req.url)
      if (reqZone !== INVALID_ZONE_ID && (await isReservedZoneId(reqZone))) {
        return reply.code(403).send({ error: 'system_zone_read_only' })
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
