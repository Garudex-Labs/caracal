// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS mint rate limit endpoints: read and set the working per-minute mint budget.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { resolveAttribution } from '../attribution.js'

const RateLimitBody = z.object({ limit_per_minute: z.number().int().min(1) }).strict()

interface RateLimitRow {
  limit_per_minute: number
  updated_by: string | null
  updated_at: string
}

// The working limit is a single platform-wide value: the STS enforces it per zone,
// resource, and acting application on every mint. STS_MINT_RATE_LIMIT_PER_MIN is the
// deployment ceiling; operators can only tighten the working limit below it, never
// extend it.
export const mintRateLimitRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/mint-rate-limit', async () => {
    const max = fastify.cfg?.stsMintRateLimitPerMin ?? 1000
    const { rows } = await fastify.db.query<RateLimitRow>(
      'SELECT limit_per_minute, updated_by, updated_at FROM sts_rate_limit WHERE singleton',
    )
    const configured = rows[0]?.limit_per_minute
    return {
      limit_per_minute: configured === undefined ? max : Math.min(configured, max),
      max_per_minute: max,
      updated_by: rows[0]?.updated_by ?? null,
      updated_at: rows[0]?.updated_at ?? null,
    }
  })

  fastify.put('/mint-rate-limit', async (req, reply) => {
    const body = RateLimitBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' })
    const max = fastify.cfg?.stsMintRateLimitPerMin ?? 1000
    if (body.data.limit_per_minute > max) {
      return reply.code(400).send({ error: 'rate_limit_above_ceiling', max_per_minute: max })
    }
    const attribution = await resolveAttribution(req, fastify.db, null)
    const { rows } = await fastify.db.query<RateLimitRow>(
      `INSERT INTO sts_rate_limit (singleton, limit_per_minute, updated_by) VALUES (true, $1, $2)
       ON CONFLICT (singleton)
       DO UPDATE SET limit_per_minute = EXCLUDED.limit_per_minute, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING limit_per_minute, updated_by, updated_at`,
      [body.data.limit_per_minute, attribution.actor],
    )
    return {
      limit_per_minute: rows[0].limit_per_minute,
      max_per_minute: max,
      updated_by: rows[0].updated_by,
      updated_at: rows[0].updated_at,
    }
  })
}
