// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TypeScript shared environment classification tests for production safety.

import { afterEach, describe, expect, it } from 'vitest'
import { assertPublishedSafe, caracalMode, isPublished } from '../../../../packages/core/ts/src/env.js'

const KEYS = ['CARACAL_MODE', 'INSECURE_STS', 'INSECURE_HTTP']

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

describe('caracalMode', () => {
  it('defaults to stable when unset', () => {
    expect(caracalMode()).toBe('stable')
    expect(isPublished()).toBe(true)
  })

  it('normalizes explicit dev, rc, and stable modes', () => {
    for (const [raw, mode, published] of [
      [' DEV ', 'dev', false],
      ['rc', 'rc', true],
      ['stable', 'stable', true],
    ] as const) {
      process.env.CARACAL_MODE = raw
      expect(caracalMode()).toBe(mode)
      expect(isPublished()).toBe(published)
    }
  })

  it('rejects invalid modes at startup', () => {
    process.env.CARACAL_MODE = 'prod'

    expect(() => caracalMode()).toThrow("CARACAL_MODE must be 'dev', 'rc', or 'stable'")
  })
})

describe('assertPublishedSafe', () => {
  it('allows developer escape hatches only in dev mode', () => {
    process.env.CARACAL_MODE = 'dev'
    process.env.INSECURE_STS = 'true'
    process.env.INSECURE_HTTP = 'yes'

    expect(() => assertPublishedSafe()).not.toThrow()
  })

  it('blocks insecure toggles in rc and stable modes', () => {
    for (const mode of ['rc', 'stable'] as const) {
      process.env.CARACAL_MODE = mode
      process.env.INSECURE_STS = '1'
      process.env.INSECURE_HTTP = 'true'

      expect(() => assertPublishedSafe()).toThrow('INSECURE_STS, INSECURE_HTTP')
    }
  })

  it('ignores false-like insecure toggles in published modes', () => {
    process.env.CARACAL_MODE = 'stable'
    process.env.INSECURE_STS = 'false'
    process.env.INSECURE_HTTP = '0'

    expect(() => assertPublishedSafe()).not.toThrow()
  })
})
