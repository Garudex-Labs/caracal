// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the local authorization guard for Control API management.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authorizeControlManagementAccess } from '../../../../packages/engine/src/controlAccess.js'

const SAVED = { ...process.env }
let dir: string

function writeLocalToken(value: string) {
  writeFileSync(join(dir, 'caracalAdminToken'), value, 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caracal-ctrl-'))
  process.env.CARACAL_SECRETS_DIR = dir
  process.env.CARACAL_HOME = dir
  delete process.env.CARACAL_REPO_ROOT
  delete process.env.CARACAL_MODE
  delete process.env.CARACAL_ALLOW_WORKSPACE_SECRETS
})

afterEach(() => {
  process.env = { ...SAVED }
  rmSync(dir, { recursive: true, force: true })
})

describe('authorizeControlManagementAccess', () => {
  it('passes when the local token matches the default source', () => {
    writeLocalToken('secret-token')
    expect(() =>
      authorizeControlManagementAccess({ env: { CARACAL_SECRETS_DIR: dir, CARACAL_HOME: dir }, requireTty: false }),
    ).not.toThrow()
  })

  it('passes when an env token matches the local token', () => {
    writeLocalToken('match-me')
    expect(() =>
      authorizeControlManagementAccess({
        env: { CARACAL_SECRETS_DIR: dir, CARACAL_HOME: dir, CARACAL_ADMIN_TOKEN: 'match-me' },
        requireTty: false,
      }),
    ).not.toThrow()
  })

  it('throws when the env token does not match', () => {
    writeLocalToken('local')
    expect(() =>
      authorizeControlManagementAccess({
        env: { CARACAL_SECRETS_DIR: dir, CARACAL_HOME: dir, CARACAL_ADMIN_TOKEN: 'different' },
        requireTty: false,
      }),
    ).toThrow(/does not match the local managed secret/)
  })

  it('reads the token from CARACAL_ADMIN_TOKEN_FILE', () => {
    writeLocalToken('from-file')
    const tokenFile = join(dir, 'admin.token')
    writeFileSync(tokenFile, 'from-file\n', 'utf8')
    expect(() =>
      authorizeControlManagementAccess({
        env: { CARACAL_SECRETS_DIR: dir, CARACAL_HOME: dir, CARACAL_ADMIN_TOKEN_FILE: tokenFile },
        requireTty: false,
      }),
    ).not.toThrow()
  })

  it('throws when the configured token file is empty or missing', () => {
    writeLocalToken('local')
    expect(() =>
      authorizeControlManagementAccess({
        env: { CARACAL_SECRETS_DIR: dir, CARACAL_HOME: dir, CARACAL_ADMIN_TOKEN_FILE: join(dir, 'missing.token') },
        requireTty: false,
      }),
    ).toThrow(/empty or missing/)
  })

  it('throws when no local managed token exists', () => {
    expect(() =>
      authorizeControlManagementAccess({ env: { CARACAL_SECRETS_DIR: dir, CARACAL_HOME: dir }, requireTty: false }),
    ).toThrow(/requires the local managed admin token/)
  })

  it('throws when an interactive TTY session is required but absent', () => {
    writeLocalToken('local')
    expect(() =>
      authorizeControlManagementAccess({
        env: { CARACAL_SECRETS_DIR: dir, CARACAL_HOME: dir },
        requireTty: true,
        stdinIsTTY: false,
        stdoutIsTTY: true,
      }),
    ).toThrow(/interactive Console session/)
  })

  it('passes the TTY check when both streams are interactive', () => {
    writeLocalToken('local')
    expect(() =>
      authorizeControlManagementAccess({
        env: { CARACAL_SECRETS_DIR: dir, CARACAL_HOME: dir },
        requireTty: true,
        stdinIsTTY: true,
        stdoutIsTTY: true,
      }),
    ).not.toThrow()
  })
})
