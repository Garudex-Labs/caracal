// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared keyset pagination helpers for list endpoints: hard server-side caps
// plus opaque base64url cursors over (created_at, id).

import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

export const DEFAULT_LIST_LIMIT = 200
export const MAX_LIST_LIMIT = 500

const ListQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
})

const Cursor = z.object({ ts: z.string().min(1), id: z.string().min(1) })

export interface ListPagination {
  limit: number
  cursor: { ts: string; id: string } | null
}

export function parseListPagination(req: FastifyRequest, reply: FastifyReply): ListPagination | null {
  const parsed = ListQuery.safeParse(req.query ?? {})
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_query' })
    return null
  }
  const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null
  if (parsed.data.cursor && !cursor) {
    reply.code(400).send({ error: 'invalid_cursor' })
    return null
  }
  return { limit: parsed.data.limit, cursor }
}

function decodeCursor(raw: string): { ts: string; id: string } | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = Cursor.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify({ ts, id }), 'utf8').toString('base64url')
}

export interface KeysetClause {
  conds: string[]
  values: unknown[]
}

export function appendKeysetCondition(
  base: KeysetClause,
  pagination: ListPagination,
  tsColumn = 'created_at',
  idColumn = 'id',
): { conds: string[]; values: unknown[]; limitPlaceholder: string } {
  const conds = [...base.conds]
  const values = [...base.values]
  if (pagination.cursor) {
    values.push(pagination.cursor.ts)
    values.push(pagination.cursor.id)
    conds.push(`(${tsColumn}, ${idColumn}) < ($${values.length - 1}, $${values.length})`)
  }
  values.push(pagination.limit)
  return { conds, values, limitPlaceholder: `$${values.length}` }
}

interface RowWithKey {
  id: string
  created_at: string | Date
}

export function setNextLink(
  req: FastifyRequest,
  reply: FastifyReply,
  rows: RowWithKey[],
  limit: number,
  cursorField: keyof RowWithKey = 'created_at',
): void {
  if (rows.length < limit) return
  const last = rows[rows.length - 1]
  if (!last) return
  const tsRaw = last[cursorField] as string | Date
  const ts = tsRaw instanceof Date ? tsRaw.toISOString() : new Date(tsRaw).toISOString()
  const cursor = encodeCursor(ts, last.id)
  const url = new URL(req.url, 'http://internal')
  url.searchParams.set('cursor', cursor)
  url.searchParams.set('limit', String(limit))
  reply.header('link', `<${url.pathname}${url.search}>; rel="next"`)
}
