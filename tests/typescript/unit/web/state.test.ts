// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for browser-local navbar state: the notifications center and sidebar hide preferences.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const NOTIF_KEY = 'caracal.notifications'
const SIDEBAR_KEY = 'caracal.sidebar.hidden'

function readNotifications(): Array<{ title: string; read: boolean }> {
  return JSON.parse((globalThis.localStorage.getItem(NOTIF_KEY) as string) ?? '[]')
}

function readHidden(): string[] {
  return JSON.parse((globalThis.localStorage.getItem(SIDEBAR_KEY) as string) ?? '[]')
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new LocalStorageStub()
  // Each module keeps an in-memory snapshot; reset modules so every test starts from cold storage.
  vi.resetModules()
})

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

async function notifications() {
  return import('../../../../apps/web/src/platform/state/notifications.ts')
}

async function sidebar() {
  return import('../../../../apps/web/src/platform/state/sidebarPrefs.ts')
}

describe('notifications center', () => {
  it('prepends new notifications, newest first, persisted and unread', async () => {
    const n = await notifications()
    n.pushNotification({ tone: 'info', title: 'First' })
    n.pushNotification({ tone: 'success', title: 'Second' })
    const stored = readNotifications()
    expect(stored.map((r) => r.title)).toEqual(['Second', 'First'])
    expect(stored.every((r) => r.read === false)).toBe(true)
  })

  it('caps history at 50 entries', async () => {
    const n = await notifications()
    for (let i = 0; i < 60; i++) n.pushNotification({ tone: 'info', title: `n${i}` })
    const stored = readNotifications()
    expect(stored.length).toBe(50)
    // The newest survive; the oldest are evicted.
    expect(stored[0]?.title).toBe('n59')
  })

  it('marks every notification read', async () => {
    const n = await notifications()
    n.pushNotification({ tone: 'error', title: 'Boom' })
    n.markAllRead()
    expect(readNotifications().every((r) => r.read)).toBe(true)
  })

  it('removes a single notification by id', async () => {
    const n = await notifications()
    n.pushNotification({ tone: 'info', title: 'Keep' })
    n.pushNotification({ tone: 'info', title: 'Drop' })
    const drop = readNotifications().find((r) => r.title === 'Drop') as { id: string } | undefined
    n.removeNotification((drop as unknown as { id: string }).id ?? '')
    expect(readNotifications().map((r) => r.title)).toEqual(['Keep'])
  })

  it('clears all notifications', async () => {
    const n = await notifications()
    n.pushNotification({ tone: 'info', title: 'x' })
    n.clearNotifications()
    expect(readNotifications()).toEqual([])
  })

  it('recovers from malformed stored data without throwing', async () => {
    globalThis.localStorage.setItem(NOTIF_KEY, '{not json')
    const n = await notifications()
    expect(() => n.pushNotification({ tone: 'info', title: 'ok' })).not.toThrow()
    expect(readNotifications().map((r) => r.title)).toEqual(['ok'])
  })

  it('prunes entries past their TTL', async () => {
    const dayMs = 24 * 60 * 60 * 1000
    const fresh = { id: 'a', tone: 'info', title: 'Fresh', ts: Date.now(), read: false }
    const stale = { id: 'b', tone: 'info', title: 'Stale', ts: Date.now() - dayMs - 1000, read: false }
    globalThis.localStorage.setItem(NOTIF_KEY, JSON.stringify([fresh, stale]))
    const n = await notifications()
    n.pruneExpired()
    expect(readNotifications().map((r) => r.title)).toEqual(['Fresh'])
  })

  it('pruneExpired leaves a fresh-only feed untouched', async () => {
    const n = await notifications()
    n.pushNotification({ tone: 'info', title: 'Recent' })
    n.pruneExpired()
    expect(readNotifications().map((r) => r.title)).toEqual(['Recent'])
  })
})

describe('sidebar hide preferences', () => {
  it('hides and un-hides a navigation item', async () => {
    const s = await sidebar()
    s.toggleNavItem('audit')
    expect(readHidden()).toEqual(['audit'])
    s.toggleNavItem('audit')
    expect(readHidden()).toEqual([])
  })

  it('never lets a pinned item be hidden', async () => {
    const s = await sidebar()
    for (const pinned of s.PINNED_NAV_ITEMS) s.toggleNavItem(pinned)
    expect(readHidden()).toEqual([])
  })

  it('drops pinned ids when loading previously stored preferences', async () => {
    globalThis.localStorage.setItem(SIDEBAR_KEY, JSON.stringify(['dashboard', 'audit']))
    const s = await sidebar()
    // Toggling an unrelated item forces a load+persist; the pinned id is filtered out.
    s.toggleNavItem('providers')
    expect(readHidden()).toEqual(['audit', 'providers'])
  })
})
