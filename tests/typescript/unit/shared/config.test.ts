// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TypeScript shared config tests for environment defaults and required values.

import { afterEach, describe, expect, it } from 'vitest'
import { getenv, mustGetenv } from '../../../../packages/core/ts/src/config.js'

describe('shared config', () => {
  afterEach(() => {
    delete process.env.CARACAL_TEST_VALUE
  })

  it('reads required and fallback environment values', () => {
    process.env.CARACAL_TEST_VALUE = 'configured'

    expect(mustGetenv('CARACAL_TEST_VALUE')).toBe('configured')
    expect(getenv('CARACAL_TEST_MISSING', 'fallback')).toBe('fallback')
  })

  it('throws when required values are missing or empty', () => {
    process.env.CARACAL_TEST_VALUE = ''

    expect(() => mustGetenv('CARACAL_TEST_VALUE')).toThrow('Required env var missing: CARACAL_TEST_VALUE')
  })
})