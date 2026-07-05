// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the auth boundary's provider discovery.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/editions/community/auth/client', () => ({
  authClient: {
    useSession: vi.fn(),
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    getSession: vi.fn(),
    updateUser: vi.fn(),
    changePassword: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
    listAccounts: vi.fn(),
    linkSocial: vi.fn(),
  },
}))

const realFetch = globalThis.fetch
let auth: typeof import('../../../../apps/web/src/platform/auth/index.ts')

beforeEach(async () => {
  auth = await import('../../../../apps/web/src/platform/auth/index.ts')
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.resetModules()
})

describe('fetchEnabledProviders', () => {
  it('parses the providers response', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ email: true, google: false, github: false, passwordReset: false })) as typeof fetch
    const enabled = await auth.fetchEnabledProviders()
    expect(enabled).toEqual({ email: true, google: false, github: false, passwordReset: false })
  })

  it('reports configured social providers and reset capability', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ email: true, google: true, github: false, passwordReset: true })) as typeof fetch
    const enabled = await auth.fetchEnabledProviders()
    expect(enabled.google).toBe(true)
    expect(enabled.passwordReset).toBe(true)
  })

  it('falls back to email-only when the request fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline')
    }) as typeof fetch
    const enabled = await auth.fetchEnabledProviders()
    expect(enabled).toEqual({ email: true, google: false, github: false, passwordReset: false })
  })
})
