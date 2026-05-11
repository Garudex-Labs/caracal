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

export type AdminScope = 'global' | 'zone'

export interface Actor {
  id: string
  name: string
  scope: AdminScope
  zoneId: string | null
}

export interface AdminTokenRow {
  id: string
  name: string
  scope: AdminScope
  zone_id: string | null
  token_sha256: Buffer
  revoked_at: Date | null
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor
  }
}

const BEARER_PREFIX = 'Bearer '
const MAX_ADMIN_BEARER_BYTES = 4096

function bytesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

function extractBearer(req: FastifyRequest): string | null {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith(BEARER_PREFIX)) return null
  const token = auth.slice(BEARER_PREFIX.length).trim()
  return token.length > 0 && token.length <= MAX_ADMIN_BEARER_BYTES ? token : null
}

function zoneFromUrl(url: string): string | null {
  const match = url.match(/^\/v1\/zones\/([^/?]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export async function lookupAdminToken(db: DB, plaintext: string): Promise<Actor | null> {
  const digest = sha256(plaintext)
  const { rows } = await db.query<AdminTokenRow>(
    `SELECT id, name, scope, zone_id, token_sha256, revoked_at
     FROM admin_tokens
     WHERE token_sha256 = $1 AND revoked_at IS NULL
     LIMIT 1`,
    [digest],
  )
  const row = rows[0]
  if (!row) return null
  if (!bytesEqual(row.token_sha256, digest)) return null
  return { id: row.id, name: row.name, scope: row.scope, zoneId: row.zone_id }
}

async function touchLastUsed(db: DB, tokenId: string): Promise<void> {
  await db.query(
    `UPDATE admin_tokens SET last_used_at = now() WHERE id = $1`,
    [tokenId],
  )
}

interface SeedOptions {
  envToken: string | null
  log: (msg: string) => void
}

export async function seedBootstrapAdminToken(db: DB, opts: SeedOptions): Promise<void> {
  if (!opts.envToken) return
  const digest = sha256(opts.envToken)
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM admin_tokens WHERE token_sha256 = $1 LIMIT 1`,
    [digest],
  )
  if (rows[0]) return
  const id = uuidv7()
  await db.query(
    `INSERT INTO admin_tokens (id, name, token_sha256, scope, zone_id, created_by)
     VALUES ($1, 'bootstrap', $2, 'global', NULL, 'env-bootstrap')`,
    [id, digest],
  )
  opts.log(`seeded bootstrap admin token id=${id}`)
}

export interface AuthPluginOptions {
  db: DB
  protectedPrefix?: string
}

const adminAuthImpl: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const prefix = opts.protectedPrefix ?? '/v1/'

  fastify.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith(prefix)) return

    const bearer = extractBearer(req)
    if (!bearer) {
      return reply.code(401).send({ error: 'invalid_admin_token' })
    }

    const actor = await lookupAdminToken(opts.db, bearer)
    if (!actor) {
      return reply.code(401).send({ error: 'invalid_admin_token' })
    }

    if (actor.scope === 'zone') {
      const reqZone = zoneFromUrl(req.url)
      if (!reqZone || reqZone !== actor.zoneId) {
        return reply.code(403).send({ error: 'admin_token_zone_mismatch' })
      }
    }

    req.actor = actor
    touchLastUsed(opts.db, actor.id).catch((err) => {
      req.log.warn({ err, tokenId: actor.id }, 'failed to update admin_tokens.last_used_at')
    })
  })
}

export const adminAuthPlugin = fp(adminAuthImpl, { name: 'admin-auth' })
