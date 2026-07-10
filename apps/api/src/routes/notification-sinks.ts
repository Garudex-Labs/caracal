// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Notification sink endpoints: zone-scoped webhook sinks that receive approval lifecycle events.

import type { FastifyPluginAsync } from 'fastify'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { AAD_NOTIFICATION_SINK_SECRET, sealSecretEnvelope } from '@caracalai/server-core'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { appendKeysetCondition, listPage, parseListPagination } from './list-pagination.js'
import { zoneExists } from '../zone-guard.js'
import { isUnsafeSinkAddress } from '../jobs/notification-dispatcher.js'

// The event types a sink may subscribe to: the approval lifecycle as recorded in the zone
// audit stream. The dispatcher fans out exactly these, so the subscription surface and the
// delivery surface can never disagree.
export const SINK_EVENT_TYPES = ['step_up_issued', 'step_up_decided', 'step_up_consumed'] as const

const MAX_SINKS_PER_ZONE = 20

const SinkBody = z.object({
  name: z.string().min(1).max(120),
  url: z.string().min(1).max(2048),
  event_types: z.array(z.enum(SINK_EVENT_TYPES)).min(1).max(SINK_EVENT_TYPES.length).optional(),
})

const SinkPatch = z.object({
  name: z.string().min(1).max(120).optional(),
  url: z.string().min(1).max(2048).optional(),
  event_types: z.array(z.enum(SINK_EVENT_TYPES)).min(1).max(SINK_EVENT_TYPES.length).optional(),
  active: z.boolean().optional(),
})

// A sink endpoint must be HTTPS so signed payloads never cross the network in the clear;
// plain HTTP is allowed only toward loopback for local development receivers. URLs carrying
// inline credentials are rejected outright - the signature header is the authentication.
export function validateSinkUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'sink url is not a valid absolute URL'
  }
  if (url.username || url.password) return 'sink url must not embed credentials'
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
  if (isIP(url.hostname) !== 0 && isUnsafeSinkAddress(url.hostname) && !(url.protocol === 'http:' && loopback)) {
    return 'sink url must not target a restricted address'
  }
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && loopback) return null
  return 'sink url must use https (http is allowed only for loopback)'
}

function newSinkSecret(): string {
  return `nsk_${randomBytes(24).toString('hex')}`
}

function sealSecret(secret: string): Buffer {
  return sealSecretEnvelope(Buffer.from(secret, 'utf8'), AAD_NOTIFICATION_SINK_SECRET)
}

// Every read returns the sink's configuration and delivery health, never its signing
// secret: the secret is shown exactly once at creation or rotation.
const SINK_COLUMNS = `id, zone_id, name, url, event_types, active, consecutive_failures,
       last_success_at, last_failure_at, last_error, created_at, updated_at`

function normalizedEventTypes(types: readonly string[] | undefined): string[] {
  const requested = types && types.length > 0 ? types : SINK_EVENT_TYPES
  return SINK_EVENT_TYPES.filter((t) => requested.includes(t))
}

export const notificationSinksRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/notification-sinks', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition({ conds: ['zone_id = $1'], values: [params.zoneId] }, page)
    const { rows } = await fastify.db.query(
      `SELECT ${SINK_COLUMNS}
       FROM notification_sinks WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    return listPage(rows, page.limit)
  })

  fastify.get('/zones/:zoneId/notification-sinks/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(`SELECT ${SINK_COLUMNS} FROM notification_sinks WHERE id = $1 AND zone_id = $2`, [
      params.id,
      params.zoneId,
    ])
    if (!rows[0]) return reply.code(404).send({ error: 'sink_not_found' })
    return rows[0]
  })

  // The per-sink delivery record: what was sent where, when, with how many attempts, and
  // what the receiver answered. This is the operator's ground truth when a receiver
  // reports silence, so it lists newest-first with the same keyset pagination as every
  // other feed.
  fastify.get('/zones/:zoneId/notification-sinks/:id/deliveries', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition({ conds: ['sink_id = $1', 'zone_id = $2'], values: [params.id, params.zoneId] }, page)
    const { rows } = await fastify.db.query(
      `SELECT id, sink_id, event_id, event_type, attempts, available_at, delivered_at,
              abandoned_at, response_status, last_error, created_at
       FROM notification_deliveries WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    return listPage(rows, page.limit)
  })

  // Creates a sink with a server-generated signing secret, returned exactly once. The
  // delivery cursor starts at the zone's current audit position, so a new sink receives
  // events from now on and never replays history it was not configured to see.
  fastify.post('/zones/:zoneId/notification-sinks', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const body = SinkBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_sink' })
    const urlError = validateSinkUrl(body.data.url)
    if (urlError) return reply.code(400).send({ error: 'invalid_sink_url', error_description: urlError })
    const { rows: existing } = await fastify.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM notification_sinks WHERE zone_id = $1`,
      [params.zoneId],
    )
    if (Number(existing[0]?.count ?? 0) >= MAX_SINKS_PER_ZONE) {
      return reply.code(409).send({ error: 'sink_limit_reached' })
    }
    const secret = newSinkSecret()
    const { rows } = await fastify.db.query(
      `INSERT INTO notification_sinks (id, zone_id, name, url, secret_ct, event_types, cursor_chain_seq)
       VALUES ($1, $2, $3, $4, $5, $6,
               (SELECT COALESCE(MAX(chain_seq), 0) FROM audit_events WHERE zone_id = $2))
       RETURNING ${SINK_COLUMNS}`,
      [uuidv7(), params.zoneId, body.data.name, body.data.url, sealSecret(secret), normalizedEventTypes(body.data.event_types)],
    )
    return reply.code(201).send({ ...(rows[0] as Record<string, unknown>), secret })
  })

  fastify.patch('/zones/:zoneId/notification-sinks/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = SinkPatch.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_sink' })
    if (body.data.url !== undefined) {
      const urlError = validateSinkUrl(body.data.url)
      if (urlError) return reply.code(400).send({ error: 'invalid_sink_url', error_description: urlError })
    }
    const { rows } = await fastify.db.query(
      `UPDATE notification_sinks
       SET name = COALESCE($3, name),
           url = COALESCE($4, url),
           event_types = COALESCE($5, event_types),
           active = COALESCE($6, active),
           consecutive_failures = CASE WHEN $4 IS NOT NULL THEN 0 ELSE consecutive_failures END,
           last_error = CASE WHEN $4 IS NOT NULL THEN NULL ELSE last_error END,
           updated_at = now()
       WHERE id = $1 AND zone_id = $2
       RETURNING ${SINK_COLUMNS}`,
      [
        params.id,
        params.zoneId,
        body.data.name ?? null,
        body.data.url ?? null,
        body.data.event_types ? normalizedEventTypes(body.data.event_types) : null,
        body.data.active ?? null,
      ],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'sink_not_found' })
    return rows[0]
  })

  // Replaces the signing secret and returns the new value exactly once. Rotation is a
  // hard cutover: deliveries signed after this instant verify only against the new secret,
  // so the receiver must be updated first.
  fastify.post('/zones/:zoneId/notification-sinks/:id/rotate-secret', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const secret = newSinkSecret()
    const { rows } = await fastify.db.query(
      `UPDATE notification_sinks SET secret_ct = $3, updated_at = now()
       WHERE id = $1 AND zone_id = $2
       RETURNING ${SINK_COLUMNS}`,
      [params.id, params.zoneId, sealSecret(secret)],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'sink_not_found' })
    return { ...(rows[0] as Record<string, unknown>), secret }
  })

  fastify.delete('/zones/:zoneId/notification-sinks/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rowCount } = await fastify.db.query(`DELETE FROM notification_sinks WHERE id = $1 AND zone_id = $2`, [params.id, params.zoneId])
    if (!rowCount) return reply.code(404).send({ error: 'sink_not_found' })
    return reply.code(204).send()
  })
}
