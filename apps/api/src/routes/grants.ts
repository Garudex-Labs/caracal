// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegated grant CRUD routes: creation and revocation with session invalidation.

import type { FastifyPluginAsync } from 'fastify'
import { loadZoneKek, seal } from '@caracalai/core'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { scopesAllowed } from '@caracalai/core'
import { STREAM_SESSIONS_REVOKE } from '../redis.js'
import { enqueueOutbox } from '../outbox.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'

const SESSION_REVOKE_BATCH = 1000

// Scope strings cross trust boundaries (Rego policies, upstream IdPs). Restrict to a
// safe charset and bounded length so neither side has to sanitize control characters,
// whitespace, or absurdly long values.
const ScopePattern = /^[a-z0-9:_./-]+$/
const ScopeMaxLen = 200
const Scope = z.string().min(1).max(ScopeMaxLen).regex(ScopePattern)

const GrantBody = z.object({
  application_id: z.string().min(1),
  user_id: z.string().min(1),
  resource_id: z.string().min(1),
  scopes: z.array(Scope).min(1).max(64),
})

const ProviderGrantBody = z.object({
  user_id: z.string().min(1),
  resource_id: z.string().min(1),
  provider_id: z.string().min(1),
  scopes: z.array(Scope).min(1).max(64),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_at: z.string().datetime().optional(),
})

function sealText(value: string): Buffer {
  const sealed = seal(loadZoneKek(), Buffer.from(value, 'utf8'))
  return Buffer.concat([sealed.nonce, sealed.ciphertext])
}

export const grantsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/grants', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition(
      { conds: ['zone_id = $1'], values: [params.zoneId] },
      page,
    )
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, application_id, user_id, resource_id, scopes, status, created_at
       FROM delegated_grants WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    setNextLink(req, reply, rows, page.limit)
    return rows
  })

  fastify.get('/zones/:zoneId/grants/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, application_id, user_id, resource_id, scopes, status, created_at
       FROM delegated_grants WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'grant_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/grants', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const body = GrantBody.parse(req.body)
    const { rows: refs } = await fastify.db.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM applications
           WHERE id = $2 AND zone_id = $1 AND archived_at IS NULL
             AND (expires_at IS NULL OR expires_at > now())
         ) AS application_exists,
         (SELECT scopes FROM resources WHERE id = $3 AND zone_id = $1 AND archived_at IS NULL) AS resource_scopes`,
      [params.zoneId, body.application_id, body.resource_id],
    )
    if (!refs[0]?.application_exists) {
      return reply.code(404).send({ error: 'application_not_found' })
    }
    if (!refs[0].resource_scopes) {
      return reply.code(404).send({ error: 'resource_not_found' })
    }
    if (!scopesAllowed(body.scopes, refs[0].resource_scopes)) {
      return reply.code(403).send({ error: 'grant_scopes_exceed_resource' })
    }
    const id = uuidv7()
    const { rows } = await fastify.db.query(
      `INSERT INTO delegated_grants (id, zone_id, application_id, user_id, resource_id, scopes, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       RETURNING id, zone_id, application_id, user_id, resource_id, scopes, status, created_at`,
      [id, params.zoneId, body.application_id, body.user_id, body.resource_id, body.scopes],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.post('/zones/:zoneId/provider-grants', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const parsed = ProviderGrantBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider_grant' })
    const body = parsed.data
    const { rows: refs } = await fastify.db.query<{
      provider_kind: string | null
      resource_scopes: string[] | null
      resource_provider_id: string | null
    }>(
      `SELECT
         (SELECT provider_kind FROM providers WHERE id = $2 AND zone_id = $1 AND archived_at IS NULL) AS provider_kind,
         (SELECT scopes FROM resources WHERE id = $3 AND zone_id = $1 AND archived_at IS NULL) AS resource_scopes,
         (SELECT credential_provider_id FROM resources WHERE id = $3 AND zone_id = $1 AND archived_at IS NULL) AS resource_provider_id`,
      [params.zoneId, body.provider_id, body.resource_id],
    )
    const refsRow = refs[0]
    if (!refsRow?.provider_kind) return reply.code(404).send({ error: 'provider_not_found' })
    if (refsRow.provider_kind !== 'oauth2_authorization_code') {
      return reply.code(400).send({ error: 'provider_grant_unsupported', detail: 'only oauth2_authorization_code providers use delegated provider grants' })
    }
    if (!refsRow.resource_scopes) return reply.code(404).send({ error: 'resource_not_found' })
    if (refsRow.resource_provider_id !== body.provider_id) {
      return reply.code(400).send({ error: 'provider_resource_mismatch' })
    }
    if (!scopesAllowed(body.scopes, refsRow.resource_scopes)) {
      return reply.code(403).send({ error: 'grant_scopes_exceed_resource' })
    }
    const id = uuidv7()
    const accessTokenCt = sealText(body.access_token)
    const refreshTokenCt = body.refresh_token ? sealText(body.refresh_token) : null
    const { rows } = await fastify.db.query(
      `INSERT INTO provider_grants (id, zone_id, user_id, resource_id, provider_id, scopes,
                                   access_token_ct, refresh_token_ct, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
       RETURNING id, zone_id, user_id, resource_id, provider_id, scopes, status, expires_at, created_at`,
      [id, params.zoneId, body.user_id, body.resource_id, body.provider_id, body.scopes, accessTokenCt, refreshTokenCt, body.expires_at ?? null],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.delete('/zones/:zoneId/grants/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ user_id: string }>(
        `UPDATE delegated_grants SET status = 'revoked'
         WHERE id = $1 AND zone_id = $2
         RETURNING user_id`,
        [params.id, params.zoneId],
      )
      if (!rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'grant_not_found' })
      }

      // Page session revocation so a grant covering many active sessions cannot
      // hold a long-running UPDATE lock or flood the outbox in a single batch.
      while (true) {
        const { rows: sessions } = await client.query<{ id: string }>(
          `UPDATE sessions SET status = 'revoked'
           WHERE id IN (
             SELECT id FROM sessions
             WHERE zone_id = $1 AND status = 'active' AND subject_id = $2
             ORDER BY created_at
             LIMIT $3
             FOR UPDATE SKIP LOCKED
           )
           RETURNING id`,
          [params.zoneId, rows[0].user_id, SESSION_REVOKE_BATCH],
        )
        for (const s of sessions) {
          await enqueueOutbox(client, {
            streamName: STREAM_SESSIONS_REVOKE,
            payload: { zone_id: params.zoneId, session_id: s.id, reason: 'grant_revoked', grant_id: params.id },
            requestId: req.id,
          })
        }
        if (sessions.length < SESSION_REVOKE_BATCH) break
      }

      await client.query('COMMIT')
      return reply.code(204).send()
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}
