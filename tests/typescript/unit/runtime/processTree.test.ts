// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the cross-platform process-tree boundary (spawn, kill, pnpm resolution).

import type { ChildProcess } from 'node:child_process'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const spawnSyncMock = vi.hoisted(() => vi.fn())
const existsSyncMock = vi.hoisted(() => vi.fn())
const statSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}))

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

// The boundary reads process.platform at module load, so each platform needs a cold import.
async function loadFor(platform: NodeJS.Platform) {
  setPlatform(platform)
  vi.resetModules()
  return import('../../../../apps/runtime/src/processTree.ts')
}

function fakeChild(pid: number | undefined): ChildProcess {
  return { pid, kill: vi.fn() } as unknown as ChildProcess
}

beforeEach(() => {
  vi.clearAllMocks()
  spawnMock.mockReturnValue({ on: vi.fn(), kill: vi.fn(), pid: 4321 })
  spawnSyncMock.mockReturnValue({ status: 0 })
  existsSyncMock.mockReturnValue(false)
  statSyncMock.mockReturnValue({ isFile: () => true })
  process.env = { ...ORIG_ENV }
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
  process.env = { ...ORIG_ENV }
  vi.restoreAllMocks()
})

describe('spawnTree', () => {
  it('detaches into its own process group on POSIX', async () => {
    const mod = await loadFor('linux')
    mod.spawnTree('node', ['server.js'], { cwd: '/repo' })
    const opts = spawnMock.mock.calls[0]?.[2] as Record<string, unknown>
    expect(opts.detached).toBe(true)
    expect(opts.shell).toBe(false)
    expect(opts.windowsHide).toBe(true)
  })

  it('stays attached on Windows and only shells .cmd shims', async () => {
    const mod = await loadFor('win32')
    mod.spawnTree('node', ['server.js'], {})
    expect((spawnMock.mock.calls[0]?.[2] as Record<string, unknown>).detached).toBe(false)
    expect((spawnMock.mock.calls[0]?.[2] as Record<string, unknown>).shell).toBe(false)

    mod.spawnTree('pnpm.cmd', ['--dir', 'apps/web', 'dev'], {})
    expect((spawnMock.mock.calls[1]?.[2] as Record<string, unknown>).shell).toBe(true)
  })
})

describe('killTree', () => {
  it('signals the whole process group via a negative PID on POSIX', async () => {
    const mod = await loadFor('linux')
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    mod.killTree(fakeChild(1234), 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGTERM')
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('reaps the tree with taskkill /T on Windows, forcing on SIGKILL', async () => {
    const mod = await loadFor('win32')
    mod.killTree(fakeChild(1234), 'SIGTERM')
    expect(spawnSyncMock).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/T'], expect.objectContaining({ windowsHide: true }))

    mod.killTree(fakeChild(99), 'SIGKILL')
    expect(spawnSyncMock).toHaveBeenLastCalledWith('taskkill', ['/pid', '99', '/T', '/F'], expect.objectContaining({ windowsHide: true }))
  })

  it('falls back to a direct child kill when the group teardown throws', async () => {
    const mod = await loadFor('linux')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    const child = fakeChild(1234)
    mod.killTree(child, 'SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('no-ops when the child has no pid', async () => {
    const mod = await loadFor('linux')
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    mod.killTree(fakeChild(undefined), 'SIGTERM')
    expect(killSpy).not.toHaveBeenCalled()
  })
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
