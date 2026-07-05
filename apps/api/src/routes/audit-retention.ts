// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit retention window endpoints: read and set how long audit events are kept.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

const RetentionBody = z.object({ retention_days: z.number().int().min(1) }).strict()

interface RetentionRow {
  retention_days: number
  updated_at: string
}

// The retention window is a single platform-wide value: the audit service drops monthly
// audit_events partitions older than it on every rotation tick. AUDIT_RETENTION_DAYS is
// the deployment ceiling; operators can only shorten the window below it, never extend it.
export const auditRetentionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/audit-retention', async () => {
    const max = fastify.cfg?.auditRetentionMaxDays ?? 365
    const { rows } = await fastify.db.query<RetentionRow>('SELECT retention_days, updated_at FROM audit_retention WHERE singleton')
    const configured = rows[0]?.retention_days
    return {
      retention_days: configured === undefined ? max : Math.min(configured, max),
      max_days: max,
      updated_at: rows[0]?.updated_at ?? null,
    }
  })

  fastify.put('/audit-retention', async (req, reply) => {
    const body = RetentionBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' })
    const max = fastify.cfg?.auditRetentionMaxDays ?? 365
    if (body.data.retention_days > max) {
      return reply.code(400).send({ error: 'retention_above_limit', max_days: max })
    }
    const { rows } = await fastify.db.query<RetentionRow>(
      `INSERT INTO audit_retention (singleton, retention_days) VALUES (true, $1)
       ON CONFLICT (singleton)
       DO UPDATE SET retention_days = EXCLUDED.retention_days, updated_at = now()
       RETURNING retention_days, updated_at`,
      [body.data.retention_days],
    )
    return { retention_days: rows[0].retention_days, max_days: max, updated_at: rows[0].updated_at }
  })
}
