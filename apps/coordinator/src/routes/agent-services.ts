// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Agent service registration, discovery, and zone-scoped heartbeat routes.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { ownsApplication, requireScope } from '../auth.js'

const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 500

const ServiceBody = z.object({
  application_id: z.string().min(1),
  endpoint_url: z.string().url(),
  protocol_versions: z.array(z.string().min(1)).default([]),
  framework: z.object({
    name: z.string().min(1),
    version: z.string().optional(),
  }).optional(),
  capabilities: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.unknown()).default({}),
})

const HeartbeatBody = z.object({
  service_id: z.string().min(1).optional(),
  status: z.enum(['starting', 'healthy', 'degraded', 'unhealthy']).default('healthy'),
  active_invocations: z.number().int().min(0).default(0),
  metadata: z.record(z.unknown()).default({}),
})

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
})

export const agentServicesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/zones/:zoneId/agent-services', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    const body = ServiceBody.parse(req.body)
    if (!ownsApplication(req, body.application_id)
      && !requireScope(req, `coordinator.spawn_for:${body.application_id}`)) {
      return reply.code(403).send({ error: 'application_ownership_required' })
    }
    const id = uuidv7()
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows: applications } = await client.query(
        `SELECT 1 FROM applications
         WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
         FOR SHARE`,
        [body.application_id, zoneId],
      )
      if (!applications[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'application_not_found' })
      }
      const { rows } = await client.query(
        `INSERT INTO agent_services
         (id, zone_id, application_id, endpoint_url, protocol_versions, framework_name, framework_version,
          capabilities, health, metadata_json, last_heartbeat_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'starting',$9,now())
         ON CONFLICT (zone_id, application_id, endpoint_url)
         DO UPDATE SET protocol_versions = EXCLUDED.protocol_versions,
                       framework_name = EXCLUDED.framework_name,
                       framework_version = EXCLUDED.framework_version,
                       capabilities = EXCLUDED.capabilities,
                       metadata_json = EXCLUDED.metadata_json,
                       updated_at = now()
         RETURNING id, zone_id, application_id, endpoint_url, protocol_versions,
                   framework_name, framework_version, capabilities, health, metadata_json, last_heartbeat_at`,
        [
          id,
          zoneId,
          body.application_id,
          body.endpoint_url,
          body.protocol_versions,
          body.framework?.name ?? null,
          body.framework?.version ?? null,
          body.capabilities,
          body.metadata,
        ],
      )
      await client.query('COMMIT')
      return reply.code(201).send(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.get('/zones/:zoneId/agent-services', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    const query = ListQuery.safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' })
    const { limit, cursor } = query.data
    if (cursor) {
      const { rows: probe } = await fastify.db.query(
        `SELECT 1 FROM agent_services WHERE id = $1 AND zone_id = $2`,
        [cursor, zoneId],
      )
      if (!probe[0]) return reply.code(400).send({ error: 'invalid_cursor' })
    }
    const params: unknown[] = [zoneId, limit]
    let cursorClause = ''
    if (cursor) {
      params.push(cursor)
      cursorClause = `AND id < $3`
    }
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, application_id, endpoint_url, protocol_versions,
              framework_name, framework_version, capabilities, health, metadata_json, last_heartbeat_at
       FROM agent_services
       WHERE zone_id = $1 ${cursorClause}
       ORDER BY id DESC LIMIT $2`,
      params,
    )
    const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null
    return { items: rows, next_cursor: nextCursor }
  })

  fastify.post('/zones/:zoneId/agents/:id/heartbeat', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const body = HeartbeatBody.parse(req.body)
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows: own } = await client.query<{ application_id: string; status: string }>(
        `SELECT application_id, status FROM agent_sessions
         WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
        [id, zoneId],
      )
      if (!own[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'agent_not_found' })
      }
      if (!ownsApplication(req, own[0].application_id)
        && !requireScope(req, 'coordinator.admin')
        && !requireScope(req, `coordinator.spawn_for:${own[0].application_id}`)) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'application_ownership_required' })
      }
      if (own[0].status !== 'active' && own[0].status !== 'suspended') {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'agent_not_live' })
      }
      const { rows: agents } = await client.query(
        `UPDATE agent_sessions SET last_active_at = now()
         WHERE id = $1 AND zone_id = $2
         RETURNING id, zone_id, application_id, last_active_at`,
        [id, zoneId],
      )
      let service = null
      if (body.service_id) {
        const { rows: svc } = await client.query(
          `UPDATE agent_services
           SET health = $1, metadata_json = metadata_json || $2::jsonb,
               last_heartbeat_at = now(), updated_at = now()
           WHERE id = $3 AND zone_id = $4 AND application_id = $5
           RETURNING id, zone_id, application_id, endpoint_url, protocol_versions,
                     framework_name, framework_version, capabilities, health, metadata_json, last_heartbeat_at`,
          [body.status, JSON.stringify(body.metadata), body.service_id, zoneId, agents[0].application_id],
        )
        if (!svc[0]) {
          await client.query('ROLLBACK')
          return reply.code(404).send({ error: 'agent_service_not_found' })
        }
        service = svc[0]
      }
      await client.query('COMMIT')
      return {
        agent: agents[0],
        service,
        active_invocations: body.active_invocations,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}
