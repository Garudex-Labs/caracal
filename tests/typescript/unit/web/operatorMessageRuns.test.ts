// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for refresh recovery state used by durable Operator message runs.

import { describe, expect, it } from 'vitest'

import {
  clearPendingOperatorMessage,
  makePendingOperatorMessage,
  messageRunIsActive,
  pendingOperatorMessageKey,
  readPendingOperatorMessage,
  savePendingOperatorMessage,
} from '../../../../apps/web/src/platform/operator/messageRuns'

class MemoryStore {
  values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('Operator pending message recovery', () => {
  it('creates stable ids that can be saved and read for the same conversation', () => {
    const store = new MemoryStore()
    const pending = makePendingOperatorMessage('z1', 'conv-1', 'Say hi', '1234', 1000)
    savePendingOperatorMessage(pending, store)
    expect(readPendingOperatorMessage('z1', 'conv-1', 2000, store)).toEqual({
      zoneId: 'z1',
      conversationId: 'conv-1',
      clientMessageId: 'web.1234',
      correlationId: 'web.1234',
      text: 'Say hi',
      createdAt: 1000,
    })
  })

  it('does not recover a pending message for a different conversation', () => {
    const store = new MemoryStore()
    savePendingOperatorMessage(makePendingOperatorMessage('z1', 'conv-1', 'Say hi', '1234', 1000), store)
    expect(readPendingOperatorMessage('z1', 'conv-2', 2000, store)).toBeNull()
  })

  it('clears corrupt and stale pending messages instead of replaying them', () => {
    const store = new MemoryStore()
    const key = pendingOperatorMessageKey('z1', 'conv-1')
    store.setItem(key, '{')
    expect(readPendingOperatorMessage('z1', 'conv-1', 2000, store)).toBeNull()
    expect(store.getItem(key)).toBeNull()

    savePendingOperatorMessage(makePendingOperatorMessage('z1', 'conv-1', 'Say hi', '1234', 1000), store)
    expect(readPendingOperatorMessage('z1', 'conv-1', 10 * 60 * 1000 + 1001, store)).toBeNull()
    expect(store.getItem(key)).toBeNull()
  })

  it('clears a pending message after a terminal result', () => {
    const store = new MemoryStore()
    const pending = makePendingOperatorMessage('z1', 'conv-1', 'Say hi', '1234', 1000)
    savePendingOperatorMessage(pending, store)
    clearPendingOperatorMessage('z1', 'conv-1', store)
    expect(readPendingOperatorMessage('z1', 'conv-1', 2000, store)).toBeNull()
  })

  it('distinguishes active and terminal run states', () => {
    expect(messageRunIsActive('waiting_for_model')).toBe(true)
    expect(messageRunIsActive('completed')).toBe(false)
    expect(messageRunIsActive('failed')).toBe(false)
  })
})
