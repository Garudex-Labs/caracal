// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the keyset list pagination helpers.

import { describe, it, expect, vi } from 'vitest'
import {
  appendKeysetCondition,
  encodeCursor,
  parseListPagination,
  setNextLink,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from '../../../../../apps/api/src/routes/list-pagination.js'

function fakeReply() {
  const sent: { code?: number; body?: unknown; headers: Record<string, string> } = { headers: {} }
  return {
    sent,
    code: vi.fn((c: number) => { sent.code = c; return reply }),
    send: vi.fn((b: unknown) => { sent.body = b; return reply }),
    header: vi.fn((k: string, v: string) => { sent.headers[k.toLowerCase()] = v; return reply }),
  } as never
  // The factory form below assigns then returns; intermediate name needed for chaining.
}

function makeReply() {
  const headers: Record<string, string> = {}
  const sent: { code?: number; body?: unknown } = {}
  const reply: { code: (c: number) => typeof reply; send: (b: unknown) => typeof reply; header: (k: string, v: string) => typeof reply; sent: typeof sent; headers: typeof headers } = {
    sent,
    headers,
    code(c) { sent.code = c; return reply },
    send(b) { sent.body = b; return reply },
    header(k, v) { headers[k.toLowerCase()] = v; return reply },
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
    const out = appendKeysetCondition(
      { conds: ['zone_id = $1'], values: ['z1'] },
      { limit: 50, cursor: null },
    )
    expect(out.conds).toEqual(['zone_id = $1'])
    expect(out.values).toEqual(['z1', 50])
    expect(out.limitPlaceholder).toBe('$2')
  })

  it('appends keyset bound and limit when cursor present', () => {
    const out = appendKeysetCondition(
      { conds: ['zone_id = $1'], values: ['z1'] },
      { limit: 25, cursor: { ts: '2026-01-01T00:00:00Z', id: 'r1' } },
    )
    expect(out.conds).toEqual([
      'zone_id = $1',
      '(created_at, id) < ($2, $3)',
    ])
    expect(out.values).toEqual(['z1', '2026-01-01T00:00:00Z', 'r1', 25])
    expect(out.limitPlaceholder).toBe('$4')
  })
})

describe('setNextLink', () => {
  it('omits Link header when fewer rows than limit returned', () => {
    const reply = makeReply()
    setNextLink({ url: '/v1/zones' } as never, reply as never, [{ id: 'r1', created_at: '2026-01-01T00:00:00.000Z' }], 10)
    expect(reply.headers.link).toBeUndefined()
  })

  it('emits Link header with next-page cursor when full page returned', () => {
    const reply = makeReply()
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, created_at: `2026-0${i + 1}-01T00:00:00.000Z` }))
    setNextLink({ url: '/v1/zones?foo=bar' } as never, reply as never, rows, 3)
    expect(reply.headers.link).toBeDefined()
    expect(reply.headers.link).toContain('rel="next"')
    expect(reply.headers.link).toContain('cursor=')
    expect(reply.headers.link).toContain('limit=3')
  })
})
