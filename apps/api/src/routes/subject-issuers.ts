// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Subject issuer endpoints: zone-scoped external identity trust for subject federation.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { appendKeysetCondition, listPage, parseListPagination } from './list-pagination.js'
import { resolveAttribution } from '../attribution.js'
import { zoneExists } from '../zone-guard.js'

const MAX_ISSUERS_PER_ZONE = 20

const IssuerBody = z.object({
  issuer: z.string().min(1).max(2048),
  jwks_url: z.string().min(1).max(2048),
  audience: z.string().min(1).max(512),
})

const IssuerPatch = z.object({
  jwks_url: z.string().min(1).max(2048).optional(),
  audience: z.string().min(1).max(512).optional(),
})

// An issuer is trusted by exact iss string match and its keys are fetched from
// jwks_url, so both must be well-formed HTTPS URLs without embedded credentials,
// queries, or fragments: a lookalike issuer string or a poisoned key URL is a
// subject-impersonation vector, not a configuration nuance.
export function validateIssuerUrl(raw: string, field: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `${field} is not a valid absolute URL`
  }
  if (url.protocol !== 'https:') return `${field} must use https`
  if (url.username || url.password) return `${field} must not embed credentials`
  if (url.search || url.hash) return `${field} must not carry a query or fragment`
  return null
}

const ISSUER_COLUMNS = `id, zone_id, issuer, jwks_url, audience,
       created_at, updated_at, created_by, created_via_operator, updated_by, updated_via_operator`

export const subjectIssuersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/subject-issuers', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition({ conds: ['zone_id = $1', 'archived_at IS NULL'], values: [params.zoneId] }, page)
    const { rows } = await fastify.db.query(
      `SELECT ${ISSUER_COLUMNS}
       FROM subject_issuers WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    return listPage(rows, page.limit)
  })

  fastify.get('/zones/:zoneId/subject-issuers/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT ${ISSUER_COLUMNS} FROM subject_issuers WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'subject_issuer_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/subject-issuers', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const body = IssuerBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_subject_issuer' })
    for (const [field, value] of [
      ['issuer', body.data.issuer],
      ['jwks_url', body.data.jwks_url],
    ] as const) {
      const urlError = validateIssuerUrl(value, field)
      if (urlError) return reply.code(400).send({ error: 'invalid_subject_issuer', error_description: urlError })
    }
    const { rows: existing } = await fastify.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM subject_issuers WHERE zone_id = $1 AND archived_at IS NULL`,
      [params.zoneId],
    )
    if (Number(existing[0]?.count ?? 0) >= MAX_ISSUERS_PER_ZONE) {
      return reply.code(409).send({ error: 'subject_issuer_limit_reached' })
    }
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    try {
      const { rows } = await fastify.db.query(
        `INSERT INTO subject_issuers (id, zone_id, issuer, jwks_url, audience, created_by, created_via_operator)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${ISSUER_COLUMNS}`,
        [uuidv7(), params.zoneId, body.data.issuer, body.data.jwks_url, body.data.audience, attribution.actor, attribution.viaOperator],
      )
      return reply.code(201).send(rows[0])
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'subject_issuer_exists' })
      }
      throw err
    }
  })

  fastify.patch('/zones/:zoneId/subject-issuers/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = IssuerPatch.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_subject_issuer' })
    if (body.data.jwks_url !== undefined) {
      const urlError = validateIssuerUrl(body.data.jwks_url, 'jwks_url')
      if (urlError) return reply.code(400).send({ error: 'invalid_subject_issuer', error_description: urlError })
    }
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    const { rows } = await fastify.db.query(
      `UPDATE subject_issuers
       SET jwks_url = COALESCE($3, jwks_url),
           audience = COALESCE($4, audience),
           updated_by = $5, updated_via_operator = $6, updated_at = now()
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
       RETURNING ${ISSUER_COLUMNS}`,
      [params.id, params.zoneId, body.data.jwks_url ?? null, body.data.audience ?? null, attribution.actor, attribution.viaOperator],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'subject_issuer_not_found' })
    return rows[0]
  })

  // Archiving withdraws trust immediately for new federations; sessions already
  // minted from the issuer live until expiry or revocation, matching every other
  // authority-source removal in the platform.
  fastify.delete('/zones/:zoneId/subject-issuers/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    const { rows } = await fastify.db.query(
      `UPDATE subject_issuers
       SET archived_at = now(), updated_by = $3, updated_via_operator = $4, updated_at = now()
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
       RETURNING id`,
      [params.id, params.zoneId, attribution.actor, attribution.viaOperator],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'subject_issuer_not_found' })
    return reply.code(204).send()
  })
}
