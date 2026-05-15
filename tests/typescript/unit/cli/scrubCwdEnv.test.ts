// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the cwd dotenv scrubber that neutralizes Bun's auto-loaded values.

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scrubCwdEnv } from '../../../../apps/cli/src/runtime/scrubCwdEnv.ts'

let dir: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caracal-scrub-'))
  env = {}
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('scrubCwdEnv', () => {
  test('removes CARACAL_* values matching cwd .env', () => {
    writeFileSync(join(dir, '.env'), 'CARACAL_ADMIN_TOKEN=cwd-leak\n')
    env.CARACAL_ADMIN_TOKEN = 'cwd-leak'
    scrubCwdEnv(dir, env)
    expect(env.CARACAL_ADMIN_TOKEN).toBeUndefined()
  })

  test('preserves shell-set values that differ from cwd .env', () => {
    writeFileSync(join(dir, '.env'), 'CARACAL_ADMIN_TOKEN=cwd-leak\n')
    env.CARACAL_ADMIN_TOKEN = 'shell-wins'
    scrubCwdEnv(dir, env)
    expect(env.CARACAL_ADMIN_TOKEN).toBe('shell-wins')
  })

  test('does not touch non-CARACAL keys', () => {
    writeFileSync(join(dir, '.env'), 'OTHER_TOKEN=ignored\n')
    env.OTHER_TOKEN = 'ignored'
    scrubCwdEnv(dir, env)
    expect(env.OTHER_TOKEN).toBe('ignored')
  })

  test('handles double-quoted values', () => {
    writeFileSync(join(dir, '.env'), 'CARACAL_API_URL="https://api"\n')
    env.CARACAL_API_URL = 'https://api'
    scrubCwdEnv(dir, env)
    expect(env.CARACAL_API_URL).toBeUndefined()
  })

  test('handles single-quoted values', () => {
    writeFileSync(join(dir, '.env'), "CARACAL_API_URL='https://api'\n")
    env.CARACAL_API_URL = 'https://api'
    scrubCwdEnv(dir, env)
    expect(env.CARACAL_API_URL).toBeUndefined()
  })

  test('reads .env.local in addition to .env', () => {
    writeFileSync(join(dir, '.env.local'), 'CARACAL_ADMIN_TOKEN=local-leak\n')
    env.CARACAL_ADMIN_TOKEN = 'local-leak'
    scrubCwdEnv(dir, env)
    expect(env.CARACAL_ADMIN_TOKEN).toBeUndefined()
  })

  test('no-op when no dotenv files present', () => {
    env.CARACAL_ADMIN_TOKEN = 'untouched'
    scrubCwdEnv(dir, env)
    expect(env.CARACAL_ADMIN_TOKEN).toBe('untouched')
  })
})
