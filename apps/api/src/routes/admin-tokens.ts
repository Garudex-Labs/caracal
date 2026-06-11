// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Admin token management: global-only minting, listing, and revocation of zone-scoped operator credentials.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { randomBytes } from 'node:crypto'
import { sha256 } from '@caracalai/core'
import { hashAdminToken } from '../hash-secret.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'

const MintBody = z
  .object({
    name: z.string().min(1).max(120),
    scope: z.enum(['global', 'zone']),
    zone_id: z.string().min(1).max(128).optional(),
  })
  .strict()

const IdParams = z.object({ id: z.string().min(1).max(128) }).strict()

// Caracal admin token: 256 bits of entropy with a recognizable prefix so the
// secret is detectable by scanners and never confused with other credentials.
function generateAdminToken(): string {
  return `cat_${randomBytes(32).toString('base64url')}`
}

// Admin token management mints credentials, so it is restricted to global
// actors. The auth plugin already denies zone-scoped actors at this path; this
// is the in-handler defense in depth that does not rely on URL heuristics.
function requireGlobalActor(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.actor?.scope !== 'global') {
    reply.code(403).send({ error: 'admin_token_management_requires_global' })
    return false
  }
  return true
}

export const adminTokensRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/admin-tokens', async (req, reply) => {
    if (!requireGlobalActor(req, reply)) return
    const parsed = MintBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_admin_token_request' })
    const body = parsed.data
    if (body.scope === 'zone') {
      if (!body.zone_id) return reply.code(400).send({ error: 'zone_id_required' })
      if (!(await zoneExists(fastify.db, body.zone_id))) {
        return reply.code(404).send({ error: 'zone_not_found' })
      }
    } else if (body.zone_id) {
      return reply.code(400).send({ error: 'zone_id_not_allowed_for_global' })
    }

    const token = generateAdminToken()
    const id = uuidv7()
    const tokenHash = await hashAdminToken(token)
    const { rows } = await fastify.db.query<{
      id: string
      name: string
      scope: string
      zone_id: string | null
      created_by: string
      created_at: Date
    }>(
      `INSERT INTO admin_tokens (id, name, token_sha256, token_hash, scope, zone_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, scope, zone_id, created_by, created_at`,
      [id, body.name, sha256(token), tokenHash, body.scope, body.scope === 'zone' ? body.zone_id : null, `admin:${req.actor.id}`],
    )
    const row = rows[0]
    if (!row) return reply.code(500).send({ error: 'admin_token_mint_failed' })
    // The plaintext token is returned exactly once and is never stored or logged.
    return reply.code(201).send({
      id: row.id,
      name: row.name,
      scope: row.scope,
      zone_id: row.zone_id,
      created_by: row.created_by,
      created_at: row.created_at,
      token,
    })
  })

  fastify.get('/admin-tokens', async (req, reply) => {
    if (!requireGlobalActor(req, reply)) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition({ conds: ['1 = 1'], values: [] }, page)
    const { rows } = await fastify.db.query(
      `SELECT id, name, scope, zone_id, created_by, created_at, last_used_at, revoked_at
       FROM admin_tokens WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    setNextLink(req, reply, rows as { id: string; created_at: string | Date }[], page.limit)
    return rows
  })

  fastify.delete('/admin-tokens/:id', async (req, reply) => {
    if (!requireGlobalActor(req, reply)) return
    const params = IdParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid_admin_token_id' })
    const { rows } = await fastify.db.query(
      `UPDATE admin_tokens SET revoked_at = now()
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [params.data.id],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'admin_token_not_found' })
    return reply.code(204).send()
  })
}
