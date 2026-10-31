// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for shim-free pnpm resolution.

import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const existsSyncMock = vi.hoisted(() => vi.fn())
const statSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsSyncMock,
  statSync: statSyncMock,
}))

const ORIG_PLATFORM = process.platform
const ORIG_ENV = { ...process.env }

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

// The pnpm binary names depend on process.platform at module load, so each platform needs a cold import.
async function loadFor(platform: NodeJS.Platform) {
  setPlatform(platform)
  vi.resetModules()
  return import('../../../../apps/runtime/src/pnpm.ts')
}

beforeEach(() => {
  vi.clearAllMocks()
  existsSyncMock.mockReturnValue(false)
  statSyncMock.mockReturnValue({ isFile: () => true })
  process.env = { ...ORIG_ENV }
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
  process.env = { ...ORIG_ENV }
  vi.restoreAllMocks()
})

describe('resolvePnpm', () => {
  it('prefers running the pnpm CLI module with the current Node binary', async () => {
    const mod = await loadFor('linux')
    process.env.npm_execpath = '/usr/lib/pnpm/pnpm.cjs'
    const resolved = mod.resolvePnpm()
    expect(resolved).toEqual({ cmd: process.execPath, prefix: ['/usr/lib/pnpm/pnpm.cjs'] })
  })

  it('falls back to the pnpm shim on the Windows PATH', async () => {
    const mod = await loadFor('win32')
    delete process.env.npm_execpath
    process.env.PATH = ['shims', 'other'].join(delimiter)
    const shim = join('shims', 'pnpm.cmd')
    existsSyncMock.mockImplementation((path: string) => path === shim)
    expect(mod.resolvePnpm()).toEqual({ cmd: shim, prefix: [] })
  })

  it('resolves nothing when pnpm is absent from the PATH', async () => {
    const mod = await loadFor('win32')
    delete process.env.npm_execpath
    process.env.PATH = 'shims'
    expect(mod.resolvePnpm()).toBeUndefined()
  })
})
