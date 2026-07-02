// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests that notifications are scoped per bound account so a different login never sees another account's feed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

class LocalStorageStub {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
}

let mod: typeof import('../../../../apps/web/src/platform/state/notifications.ts')

beforeEach(async () => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new LocalStorageStub()
  mod = await import('../../../../apps/web/src/platform/state/notifications.ts')
})

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

function entries(account: string): number {
  const raw = localStorage.getItem(`caracal.notifications.${account}`)
  return raw ? (JSON.parse(raw) as unknown[]).length : 0
}

describe('account-scoped notifications', () => {
  it('writes a separate feed per bound account', () => {
    localStorage.setItem('caracal.owner', '"user-A"')
    mod.refreshNotificationsForIdentity()
    mod.pushNotification({ tone: 'info', title: 'A only' })
    expect(entries('user-A')).toBe(1)

    localStorage.setItem('caracal.owner', '"user-B"')
    mod.refreshNotificationsForIdentity()
    expect(entries('user-B')).toBe(0)
    mod.pushNotification({ tone: 'info', title: 'B only' })
    expect(entries('user-B')).toBe(1)
    expect(entries('user-A')).toBe(1)
  })

  it('drops the legacy unscoped feed on identity refresh', () => {
    localStorage.setItem('caracal.notifications', JSON.stringify([{ id: 'x', tone: 'info', title: 'old', ts: Date.now(), read: false }]))
    localStorage.setItem('caracal.owner', '"user-A"')
    mod.refreshNotificationsForIdentity()
    expect(localStorage.getItem('caracal.notifications')).toBeNull()
  })
})
