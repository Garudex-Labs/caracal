// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the shared process-level crash handler and token scrubbing.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  disposeCrashHandlers,
  installCrashHandlers,
  scrubTokens,
} from '../../../../packages/engine/src/crash.js'

afterEach(() => {
  disposeCrashHandlers()
  vi.restoreAllMocks()
})

describe('scrubTokens', () => {
  it('redacts JWTs, caracal tokens, and bearer headers', () => {
    const input =
      'jwt eyJhbGciOiJF.payload.sig at caracal_at_abc123 rt caracal_rt_def456 hdr Bearer sometoken end'
    const out = scrubTokens(input)
    expect(out).not.toContain('eyJhbGciOiJF')
    expect(out).not.toContain('caracal_at_abc123')
    expect(out).not.toContain('caracal_rt_def456')
    expect(out).not.toContain('sometoken')
    expect(out).toContain('***')
  })

  it('leaves clean strings untouched', () => {
    expect(scrubTokens('nothing secret here')).toBe('nothing secret here')
  })
})

describe('installCrashHandlers', () => {
  it('routes uncaught exceptions through the scrubbed onError sink', () => {
    const lines: string[] = []
    installCrashHandlers('worker', { onError: (l) => lines.push(l), exitOnError: false })
    const handler = process.listeners('uncaughtException').at(-1) as (err: unknown) => void
    handler(new Error('token caracal_at_secret leaked'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('worker:')
    expect(lines[0]).not.toContain('caracal_at_secret')
  })

  it('handles non-Error rejection reasons', () => {
    const lines: string[] = []
    installCrashHandlers('worker', { onError: (l) => lines.push(l), exitOnError: false })
    const handler = process.listeners('unhandledRejection').at(-1) as (reason: unknown) => void
    handler('plain string reason')
    expect(lines[0]).toContain('plain string reason')
  })

  it('is idempotent across repeated installs', () => {
    const before = process.listeners('uncaughtException').length
    installCrashHandlers('worker', { exitOnError: false })
    installCrashHandlers('worker', { exitOnError: false })
    expect(process.listeners('uncaughtException').length).toBe(before + 1)
  })

  it('writes to stderr when no onError sink is provided', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    installCrashHandlers('worker', { exitOnError: false })
    const handler = process.listeners('uncaughtException').at(-1) as (err: unknown) => void
    handler(new Error('oops'))
    expect(spy).toHaveBeenCalled()
  })

  it('calls process.exit when exitOnError is enabled', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    installCrashHandlers('worker', { onError: () => {} })
    const handler = process.listeners('uncaughtException').at(-1) as (err: unknown) => void
    handler(new Error('fatal'))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

describe('disposeCrashHandlers', () => {
  it('removes installed listeners and is safe to call when none installed', () => {
    disposeCrashHandlers()
    const before = process.listeners('uncaughtException').length
    installCrashHandlers('worker', { exitOnError: false })
    disposeCrashHandlers()
    expect(process.listeners('uncaughtException').length).toBe(before)
  })
})
