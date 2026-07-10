// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared Zod schemas and helpers for validating route params.

import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

const idShape = z.string().regex(/^[A-Za-z0-9_.\-:]{1,128}$/)

export const ZoneParams = z.object({ zoneId: idShape })
export const ZoneIdParams = z.object({ zoneId: idShape, id: idShape })
export const IdParams = z.object({ id: idShape })

export function parseParams<T extends z.ZodTypeAny>(schema: T, req: FastifyRequest, reply: FastifyReply): z.infer<T> | null {
  const parsed = schema.safeParse(req.params)
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_params' })
    return null
  }
  return parsed.data
}
