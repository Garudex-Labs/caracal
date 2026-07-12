// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for persistent per-conversation Operator memory: isolated recall, rendering, and governed deduplicated writes.

import { describe, it, expect, vi } from 'vitest'
import {
  recallConversationMemory,
  describeConversationMemory,
  rememberAppliedChange,
  type ConversationMemoryEntry,
} from '../../../../apps/api/src/operator-conversation-memory.js'

describe('recallConversationMemory', () => {
  it('reads only this conversation\u2019s memory, newest first, under a bounded limit', async () => {
    const rows: ConversationMemoryEntry[] = [{ text: 'Register the Anton application', created_at: '2026-06-02T00:00:00Z' }]
    const query = vi.fn().mockResolvedValue({ rows })
    const entries = await recallConversationMemory({ query }, 'z1', 'conv-1', 5)
    expect(entries).toEqual(rows)
    const [sql, params] = query.mock.calls[0]
    expect(String(sql)).toContain('FROM operator_zone_memory')
    expect(String(sql)).toContain('conversation_id = $2')
    expect(String(sql)).toContain('ORDER BY created_at DESC')
    expect(params).toEqual(['z1', 'conv-1', 5])
  })

  it('never reads fewer than one entry even for a non-positive limit', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await recallConversationMemory({ query }, 'z1', 'conv-1', 0)
    expect(query.mock.calls[0][1]).toEqual(['z1', 'conv-1', 1])
  })
})

describe('describeConversationMemory', () => {
  it('returns an empty string when the chat has no memory yet', () => {
    expect(describeConversationMemory(undefined)).toBe('')
    expect(describeConversationMemory([])).toBe('')
  })

  it('renders durable memory as a dated, history-only activity log of this chat', () => {
    const block = describeConversationMemory([
      { text: 'Connect the Hooli OIDC provider', created_at: '2026-06-01T00:00:00Z' },
      { text: 'Register the Anton application', created_at: '2026-06-02T00:00:00Z' },
    ])
    expect(block).toContain('Durable memory of this chat')
    expect(block).toContain('history only, not current state')
    expect(block).toContain('never treat an entry as proof the object still exists')
    expect(block).toContain('- 2026-06-01: applied "Connect the Hooli OIDC provider"')
    expect(block).toContain('- 2026-06-02: applied "Register the Anton application"')
  })
})

describe('rememberAppliedChange', () => {
  it('writes a bounded memory deduplicated within the conversation', async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    await rememberAppliedChange({ query }, 'z1', 'conv-1', 'Register the Anton application')
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]
    expect(String(sql)).toContain('INSERT INTO operator_zone_memory')
    expect(String(sql)).toContain('WHERE NOT EXISTS')
    expect(String(sql)).toContain('conversation_id = $3')
    expect(params[1]).toBe('z1')
    expect(params[2]).toBe('conv-1')
    expect(params[3]).toBe('Register the Anton application')
  })

  it('does not write an empty memory', async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    await rememberAppliedChange({ query }, 'z1', 'conv-1', '   ')
    expect(query).not.toHaveBeenCalled()
  })
})
