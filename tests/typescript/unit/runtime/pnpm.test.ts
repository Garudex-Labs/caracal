// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for shim-free pnpm resolution.

import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

const existsSyncMock = vi.hoisted(() => vi.fn())
const statSyncMock = vi.hoisted(() => vi.fn())
const accessSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  accessSync: accessSyncMock,
  existsSync: existsSyncMock,
  statSync: statSyncMock,
}))

const ORIG_PLATFORM = process.platform
const ORIG_ENV = { ...process.env }

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

// The pnpm binary names depend on process.platform at module load, so each platform needs a cold
// import. node:path binds to the host OS instead, so Windows runs swap in its win32 flavor.
async function loadFor(platform: NodeJS.Platform) {
  setPlatform(platform)
  vi.resetModules()
  vi.doUnmock('node:path')
  if (platform === 'win32') {
    vi.doMock('node:path', async (importOriginal) => (await importOriginal<typeof import('node:path')>()).win32)
  }
  return import('../../../../apps/runtime/src/pnpm.ts')
}

beforeEach(() => {
  vi.clearAllMocks()
  existsSyncMock.mockReturnValue(false)
  accessSyncMock.mockReset()
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
    existsSyncMock.mockImplementation((path: string) => path === '/usr/lib/pnpm/pnpm.cjs')
    const resolved = mod.resolvePnpm()
    expect(resolved).toEqual({ cmd: process.execPath, prefix: ['/usr/lib/pnpm/pnpm.cjs'] })
  })

  it('runs a native pnpm entry directly instead of through Node', async () => {
    const mod = await loadFor('linux')
    process.env.npm_execpath = '/usr/local/bin/pnpm'
    existsSyncMock.mockImplementation((path: string) => path === '/usr/local/bin/pnpm')
    expect(mod.resolvePnpm()).toEqual({ cmd: '/usr/local/bin/pnpm', prefix: [] })
  })

  it('ignores an npm entry whose path merely contains pnpm', async () => {
    const mod = await loadFor('linux')
    process.env.npm_execpath = '/opt/pnpm/node_modules/npm/bin/npm-cli.js'
    process.env.PATH = '/usr/local/bin'
    existsSyncMock.mockImplementation((path: string) => path === '/usr/local/bin/pnpm')
    expect(mod.resolvePnpm()).toEqual({ cmd: '/usr/local/bin/pnpm', prefix: [] })
  })

  it('falls back to PATH when the npm_execpath target is gone', async () => {
    const mod = await loadFor('linux')
    process.env.npm_execpath = '/gone/pnpm.cjs'
    process.env.PATH = '/usr/local/bin'
    existsSyncMock.mockImplementation((path: string) => path === '/usr/local/bin/pnpm')
    expect(mod.resolvePnpm()).toEqual({ cmd: '/usr/local/bin/pnpm', prefix: [] })
  })

  it('does not run a pnpm script through a compiled caracal binary', async () => {
    const mod = await loadFor('linux')
    process.env.npm_execpath = '/usr/lib/pnpm/pnpm.cjs'
    process.env.PATH = '/usr/local/bin'
    existsSyncMock.mockImplementation((path: string) => path === '/usr/lib/pnpm/pnpm.cjs' || path === '/usr/local/bin/pnpm')
    Object.defineProperty(process.versions, 'bun', { value: '1.3.14', configurable: true })
    onTestFinished(() => void delete (process.versions as Record<string, unknown>).bun)
    expect(mod.resolvePnpm()).toEqual({ cmd: '/usr/local/bin/pnpm', prefix: [] })
  })

  it('skips a pnpm on PATH it cannot execute', async () => {
    const mod = await loadFor('linux')
    delete process.env.npm_execpath
    process.env.PATH = '/first:/second'
    existsSyncMock.mockReturnValue(true)
    accessSyncMock.mockImplementation((path: string) => {
      if (path === '/first/pnpm') throw new Error('EACCES')
    })
    expect(mod.resolvePnpm()).toEqual({ cmd: '/second/pnpm', prefix: [] })
  })

  it('resolves a relative PATH entry to an absolute path', async () => {
    const mod = await loadFor('linux')
    delete process.env.npm_execpath
    process.env.PATH = './tools'
    const absolute = resolve('tools', 'pnpm')
    existsSyncMock.mockImplementation((path: string) => path === absolute)
    expect(mod.resolvePnpm()).toEqual({ cmd: absolute, prefix: [] })
  })

  it('falls back to the pnpm shim on the Windows PATH', async () => {
    const mod = await loadFor('win32')
    delete process.env.npm_execpath
    process.env.PATH = 'D:\\other;C:\\shims'
    const shim = 'C:\\shims\\pnpm.cmd'
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
