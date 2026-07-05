// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the auth boundary's provider discovery and first-operator bootstrap sign-up.

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
  it('parses bootstrapInvite from the providers response', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ email: true, google: false, github: false, passwordReset: false, bootstrapInvite: true }),
    ) as typeof fetch
    const enabled = await auth.fetchEnabledProviders()
    expect(enabled.bootstrapInvite).toBe(true)
  })

  it('leaves bootstrapInvite unset when the response omits it', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ email: true, google: true, github: false, passwordReset: true })) as typeof fetch
    const enabled = await auth.fetchEnabledProviders()
    expect(enabled.bootstrapInvite).toBeUndefined()
  })

  it('omits bootstrapInvite from the fallback when the request fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline')
    }) as typeof fetch
    const enabled = await auth.fetchEnabledProviders()
    expect(enabled).toEqual({ email: true, google: false, github: false, passwordReset: false })
  })
})

describe('signUpFirstOperator', () => {
  it('posts the invite code alongside the standard sign-up fields', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return Response.json({ token: 't', user: { id: 'u1' } })
    }) as typeof fetch
    await auth.signUpFirstOperator({
      name: 'Richard Hendricks',
      email: 'richard.hendricks@piedpiper.example',
      password: 'aviato-is-over',
      inviteCode: 'code-123',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/api/auth/sign-up/email')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.credentials).toBe('include')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: 'Richard Hendricks',
      email: 'richard.hendricks@piedpiper.example',
      password: 'aviato-is-over',
      invite_code: 'code-123',
    })
  })

  it('surfaces registration_not_permitted as an AuthApiError', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: 'registration_not_permitted' }, { status: 403 })) as typeof fetch
    const attempt = auth.signUpFirstOperator({
      name: 'Richard Hendricks',
      email: 'richard.hendricks@piedpiper.example',
      password: 'aviato-is-over',
      inviteCode: 'expired',
    })
    await expect(attempt).rejects.toMatchObject({ status: 403, code: 'registration_not_permitted' })
    await expect(attempt).rejects.toBeInstanceOf(auth.AuthApiError)
  })
})
