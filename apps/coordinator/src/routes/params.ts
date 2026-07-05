// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared Zod schemas and helpers for validating coordinator route params.

import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

export const CoordinatorIdPattern = /^[A-Za-z0-9_.\-:]{1,128}$/

const CoordinatorId = z.string().regex(CoordinatorIdPattern)

export const ZoneParams = z.object({ zoneId: CoordinatorId })
export const ZoneIdParams = z.object({ zoneId: CoordinatorId, id: CoordinatorId })
export const ZoneSessionParams = z.object({ zoneId: CoordinatorId, sessionId: CoordinatorId })

export function parseParams<T extends z.ZodTypeAny>(schema: T, req: FastifyRequest, reply: FastifyReply): z.infer<T> | null {
  const parsed = schema.safeParse(req.params)
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_params' })
    return null
  }
  return parsed.data
}
