// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the keyset list pagination helpers.

import { describe, it, expect } from 'vitest'
import {
  appendKeysetCondition,
  encodeCursor,
  listPage,
  parseListPagination,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from '../../../../../apps/api/src/routes/list-pagination.js'

function makeReply() {
  const sent: { code?: number; body?: unknown } = {}
  const reply: {
    code: (c: number) => typeof reply
    send: (b: unknown) => typeof reply
    sent: typeof sent
  } = {
    sent,
    code(c) {
      sent.code = c
      return reply
    },
    send(b) {
      sent.body = b
      return reply
    },
  }
  return reply
}

describe('parseListPagination', () => {
  it('applies default limit when no params given', () => {
    const reply = makeReply()
    const page = parseListPagination({ query: {} } as never, reply as never)
    expect(page).toEqual({ limit: DEFAULT_LIST_LIMIT, cursor: null })
    expect(reply.sent.code).toBeUndefined()
  })

  it('caps limit at MAX_LIST_LIMIT', () => {
    const reply = makeReply()
    const page = parseListPagination({ query: { limit: String(MAX_LIST_LIMIT + 1000) } } as never, reply as never)
    expect(page).toBeNull()
    expect(reply.sent.code).toBe(400)
  })

  it('rejects malformed cursor', () => {
    const reply = makeReply()
    const page = parseListPagination({ query: { cursor: 'not-base64-encoded-json' } } as never, reply as never)
    expect(page).toBeNull()
    expect(reply.sent.code).toBe(400)
    expect(reply.sent.body).toMatchObject({ error: 'invalid_cursor' })
  })

  it('decodes valid round-trip cursor', () => {
    const reply = makeReply()
    const cursor = encodeCursor('2026-01-01T00:00:00.000Z', 'row-1')
    const page = parseListPagination({ query: { cursor, limit: '10' } } as never, reply as never)
    expect(page).toEqual({ limit: 10, cursor: { ts: '2026-01-01T00:00:00.000Z', id: 'row-1' } })
  })
})

describe('appendKeysetCondition', () => {
  it('appends only the limit when no cursor present', () => {
    const out = appendKeysetCondition({ conds: ['zone_id = $1'], values: ['z1'] }, { limit: 50, cursor: null })
    expect(out.conds).toEqual(['zone_id = $1'])
    expect(out.values).toEqual(['z1', 50])
    expect(out.limitPlaceholder).toBe('$2')
  })

  it('appends keyset bound and limit when cursor present', () => {
    const out = appendKeysetCondition(
      { conds: ['zone_id = $1'], values: ['z1'] },
      { limit: 25, cursor: { ts: '2026-01-01T00:00:00Z', id: 'r1' } },
    )
    expect(out.conds).toEqual(['zone_id = $1', '(created_at, id) < ($2, $3)'])
    expect(out.values).toEqual(['z1', '2026-01-01T00:00:00Z', 'r1', 25])
    expect(out.limitPlaceholder).toBe('$4')
  })
})

describe('listPage', () => {
  it('returns items with a null cursor when fewer rows than limit returned', () => {
    const rows = [{ id: 'r1', created_at: '2026-01-01T00:00:00.000Z' }]
    expect(listPage(rows, 10)).toEqual({ items: rows, next_cursor: null })
  })

  it('returns a null cursor for an empty page', () => {
    expect(listPage([], 10)).toEqual({ items: [], next_cursor: null })
  })

  it('encodes the last row into the cursor when a full page is returned', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, created_at: `2026-0${i + 1}-01T00:00:00.000Z` }))
    const page = listPage(rows, 3)
    expect(page.items).toEqual(rows)
    expect(page.next_cursor).toBe(encodeCursor('2026-03-01T00:00:00.000Z', 'r2'))
    expect(JSON.parse(Buffer.from(page.next_cursor!, 'base64url').toString('utf8'))).toEqual({
      ts: '2026-03-01T00:00:00.000Z',
      id: 'r2',
    })
  })

  it('normalizes Date timestamps to ISO strings in the cursor', () => {
    const page = listPage([{ id: 'r1', created_at: new Date('2026-01-01T00:00:00.000Z') }], 1)
    expect(page.next_cursor).toBe(encodeCursor('2026-01-01T00:00:00.000Z', 'r1'))
  })
})
