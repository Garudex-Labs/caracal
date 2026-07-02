// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for route guards bridging Better Auth sessions, onboarding state, and authorization redirects.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  reconcileLocalIdentity: vi.fn(),
  isOnboarded: vi.fn(),
  getActiveZoneId: vi.fn(),
  setActiveZoneId: vi.fn(),
  completeOnboarding: vi.fn(),
  getProfile: vi.fn(() => ({ fullName: '' })),
}))

// A thrown redirect is the router's real Redirect object; assert on its destination.
vi.mock('@/platform/auth', () => ({ getSession: state.getSession }))

vi.mock('@/platform/state/localInstall', () => ({
  reconcileLocalIdentity: state.reconcileLocalIdentity,
  isOnboarded: state.isOnboarded,
  getActiveZoneId: state.getActiveZoneId,
  setActiveZoneId: state.setActiveZoneId,
  completeOnboarding: state.completeOnboarding,
  getProfile: state.getProfile,
}))

const realFetch = globalThis.fetch
let guards: typeof import('../../../../apps/web/src/platform/auth/guards.ts')

beforeEach(async () => {
  vi.clearAllMocks()
  state.getProfile.mockReturnValue({ fullName: '' })
  guards = await import('../../../../apps/web/src/platform/auth/guards.ts')
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.resetModules()
})

function signedIn(): void {
  state.getSession.mockResolvedValue({ data: { user: { id: 'u1', name: 'Richard' } } })
}

function signedOut(): void {
  state.getSession.mockResolvedValue({ data: null })
}

// Drives the real console client: the guard calls consoleApi.zones.list(), which fetches
// /v1/zones. Returning rows exercises the "environment exists" branch; rejecting exercises
// the control-plane-unavailable branch (mapped to a ConsoleApiError the guard catches).
function zonesRespond(rows: Array<{ id: string }>): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch
}

function zonesUnavailable(): void {
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError('Failed to fetch')
  }) as unknown as typeof fetch
}

async function redirectFrom(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    const to = (err as { options?: { to?: string }; to?: string })?.options?.to ?? (err as { to?: string })?.to
    if (typeof to === 'string') return to
    throw err
  }
  throw new Error('expected a redirect')
}

describe('hasSession and identity reconciliation', () => {
  it('returns true for a live session and aligns local identity with the account', async () => {
    signedIn()
    expect(await guards.hasSession()).toBe(true)
    expect(state.reconcileLocalIdentity).toHaveBeenCalledWith('u1')
  })

  it('returns false when signed out and clears the local identity', async () => {
    signedOut()
    expect(await guards.hasSession()).toBe(false)
    expect(state.reconcileLocalIdentity).toHaveBeenCalledWith(null)
  })

  it('leaves local identity untouched when the session lookup fails in transit', async () => {
    state.getSession.mockResolvedValue({ data: null, error: { status: 0, statusText: 'fetch failed' } })
    expect(await guards.hasSession()).toBe(false)
    expect(state.reconcileLocalIdentity).not.toHaveBeenCalled()
  })

  it('treats a thrown session lookup (control plane down) as no session', async () => {
    state.getSession.mockRejectedValue(new Error('network'))
    expect(await guards.hasSession()).toBe(false)
  })
})

describe('requireAuthenticatedOperator', () => {
  it('passes for a signed-in operator', async () => {
    signedIn()
    await expect(guards.requireAuthenticatedOperator()).resolves.toBeUndefined()
  })

  it('redirects an unauthenticated visitor to sign-in (session expiration)', async () => {
    signedOut()
    expect(await redirectFrom(() => guards.requireAuthenticatedOperator())).toBe('/sign-in')
  })
})

describe('requireOnboardedInstallation', () => {
  it('admits an operator the browser already knows is onboarded', async () => {
    signedIn()
    state.isOnboarded.mockReturnValue(true)
    await expect(guards.requireOnboardedInstallation()).resolves.toBeUndefined()
  })

  it('hydrates from an existing backend zone when the local flag is missing', async () => {
    signedIn()
    state.isOnboarded.mockReturnValue(false)
    state.getActiveZoneId.mockReturnValue(null)
    zonesRespond([{ id: 'z1' }])
    await expect(guards.requireOnboardedInstallation()).resolves.toBeUndefined()
    expect(state.completeOnboarding).toHaveBeenCalled()
    expect(state.setActiveZoneId).toHaveBeenCalledWith('z1')
  })

  it('redirects a brand-new operator with no zones to onboarding', async () => {
    signedIn()
    state.isOnboarded.mockReturnValue(false)
    zonesRespond([])
    expect(await redirectFrom(() => guards.requireOnboardedInstallation())).toBe('/onboarding')
  })

  it('redirects to onboarding when the control plane is unavailable', async () => {
    signedIn()
    state.isOnboarded.mockReturnValue(false)
    zonesUnavailable()
    expect(await redirectFrom(() => guards.requireOnboardedInstallation())).toBe('/onboarding')
  })

  it('redirects an unauthenticated visitor to sign-in before checking onboarding', async () => {
    signedOut()
    expect(await redirectFrom(() => guards.requireOnboardedInstallation())).toBe('/sign-in')
  })
})

describe('requirePendingOnboarding', () => {
  it('sends an already-onboarded operator to the app', async () => {
    signedIn()
    state.isOnboarded.mockReturnValue(true)
    expect(await redirectFrom(() => guards.requirePendingOnboarding())).toBe('/app')
  })

  it('sends an operator with existing zones to the app', async () => {
    signedIn()
    state.isOnboarded.mockReturnValue(false)
    state.getActiveZoneId.mockReturnValue('z1')
    zonesRespond([{ id: 'z1' }])
    expect(await redirectFrom(() => guards.requirePendingOnboarding())).toBe('/app')
  })

  it('admits a genuinely new operator into the onboarding wizard', async () => {
    signedIn()
    state.isOnboarded.mockReturnValue(false)
    zonesRespond([])
    await expect(guards.requirePendingOnboarding()).resolves.toBeUndefined()
  })
})
