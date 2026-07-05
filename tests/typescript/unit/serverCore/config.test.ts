// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TypeScript shared config tests for environment defaults and required values.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boolEnv, getenv, intEnv, mustGetenv, resolveFileSecrets } from '../../../../packages/core/ts/src/config.js'

describe('shared config', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-shared-config-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.CARACAL_TEST_VALUE
    delete process.env.CARACAL_TEST_VALUE_FILE
    delete process.env.CARACAL_TEST_BOOL
    delete process.env.CARACAL_TEST_INT
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

  it('parses strict boolean and integer environment values', () => {
    process.env.CARACAL_TEST_BOOL = 'yes'
    process.env.CARACAL_TEST_INT = '42'

    expect(boolEnv('CARACAL_TEST_BOOL', false)).toBe(true)
    expect(intEnv('CARACAL_TEST_INT', 1, 1)).toBe(42)
    expect(boolEnv('CARACAL_TEST_MISSING_BOOL', true)).toBe(true)
    expect(intEnv('CARACAL_TEST_MISSING_INT', 7, 1)).toBe(7)
  })

  it('rejects invalid booleans and integers instead of silently defaulting', () => {
    process.env.CARACAL_TEST_BOOL = 'maybe'
    process.env.CARACAL_TEST_INT = '0'

    expect(() => boolEnv('CARACAL_TEST_BOOL', false)).toThrow('Invalid boolean env var CARACAL_TEST_BOOL')
    expect(() => intEnv('CARACAL_TEST_INT', 7, 1)).toThrow('Invalid integer env var CARACAL_TEST_INT')
  })

  it('resolves _FILE secrets, trims trailing whitespace, and clears file env vars', () => {
    const file = join(dir, 'secret')
    writeFileSync(file, 'secret-value\n\n')
    process.env.CARACAL_TEST_VALUE_FILE = file

    resolveFileSecrets(['CARACAL_TEST_VALUE'])

    expect(process.env.CARACAL_TEST_VALUE).toBe('secret-value')
    expect(process.env.CARACAL_TEST_VALUE_FILE).toBeUndefined()
  })

  it('preserves direct values over _FILE secrets', () => {
    const file = join(dir, 'secret')
    writeFileSync(file, 'from-file\n')
    process.env.CARACAL_TEST_VALUE = 'from-env'
    process.env.CARACAL_TEST_VALUE_FILE = file

    resolveFileSecrets(['CARACAL_TEST_VALUE'])

    expect(process.env.CARACAL_TEST_VALUE).toBe('from-env')
    expect(process.env.CARACAL_TEST_VALUE_FILE).toBe(file)
  })

  it('fails when a configured secret file is empty or missing', () => {
    const emptyFile = join(dir, 'empty')
    writeFileSync(emptyFile, ' \n')
    process.env.CARACAL_TEST_VALUE_FILE = emptyFile
    expect(() => resolveFileSecrets(['CARACAL_TEST_VALUE'])).toThrow('Secret file empty')

    delete process.env.CARACAL_TEST_VALUE_FILE
    process.env.CARACAL_TEST_VALUE_FILE = join(dir, 'missing')
    expect(() => resolveFileSecrets(['CARACAL_TEST_VALUE'])).toThrow()
  })
})
