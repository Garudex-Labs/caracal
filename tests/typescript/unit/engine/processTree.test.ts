// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the cross-platform process-tree boundary (group leadership, spawn, kill).

import type { ChildProcess } from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const spawnSyncMock = vi.hoisted(() => vi.fn())
const isattyMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}))

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: isattyMock,
}))

const ORIG_PLATFORM = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

// The boundary reads process.platform at module load, so each platform needs a cold import.
async function loadFor(platform: NodeJS.Platform) {
  setPlatform(platform)
  vi.resetModules()
  return import('../../../../packages/engine/src/processTree.ts')
}

function fakeChild(pid: number | undefined): ChildProcess {
  return { pid, kill: vi.fn() } as unknown as ChildProcess
}

beforeEach(() => {
  vi.clearAllMocks()
  spawnMock.mockReturnValue({ on: vi.fn(), kill: vi.fn(), pid: 4321 })
  spawnSyncMock.mockReturnValue({ status: 0 })
  isattyMock.mockReturnValue(false)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
  vi.restoreAllMocks()
})

describe('findExecutable', () => {
  it('returns the first matching file along the search path', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
    const { join, delimiter } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const mod = await loadFor(ORIG_PLATFORM)
    const first = mkdtempSync(join(tmpdir(), 'caracal-path-a-'))
    const second = mkdtempSync(join(tmpdir(), 'caracal-path-b-'))
    mkdirSync(join(first, 'curl'))
    writeFileSync(join(second, 'curl'), '')
    expect(mod.findExecutable(['curl'], [first, '', second].join(delimiter))).toBe(join(second, 'curl'))
    expect(mod.findExecutable(['bwrap'], [first, second].join(delimiter))).toBeUndefined()
    expect(mod.findExecutable(['curl'], undefined)).toBeUndefined()
  })
})

describe('leadsProcessGroup', () => {
  it('leads a group on POSIX when no inherited stream is a terminal', async () => {
    const mod = await loadFor('linux')
    expect(mod.leadsProcessGroup(['ignore', 'pipe', 'pipe'])).toBe(true)
    expect(mod.leadsProcessGroup('pipe')).toBe(true)
    expect(mod.leadsProcessGroup(undefined)).toBe(true)
    expect(mod.leadsProcessGroup('inherit')).toBe(true)
  })

  it('stays in the foreground group when an inherited stream is a terminal', async () => {
    const mod = await loadFor('linux')
    isattyMock.mockImplementation((fd: number) => fd === 0)
    expect(mod.leadsProcessGroup('inherit')).toBe(false)
    expect(mod.leadsProcessGroup(['inherit', 'pipe', 'pipe'])).toBe(false)
    expect(mod.leadsProcessGroup(['ignore', 'pipe', 'pipe'])).toBe(true)

    isattyMock.mockImplementation((fd: number) => fd === 2)
    expect(mod.leadsProcessGroup(['ignore', 'pipe', 'inherit'])).toBe(false)
    expect(mod.leadsProcessGroup(['inherit', 'inherit', 'pipe'])).toBe(true)
  })

  it('never leads a group on Windows', async () => {
    const mod = await loadFor('win32')
    expect(mod.leadsProcessGroup(['ignore', 'pipe', 'pipe'])).toBe(false)
  })
})

describe('spawnTree', () => {
  it('detaches into its own process group on POSIX', async () => {
    const mod = await loadFor('linux')
    mod.spawnTree('node', ['server.js'], { cwd: '/repo', stdio: ['ignore', 'pipe', 'pipe'] })
    const opts = spawnMock.mock.calls[0]?.[2] as Record<string, unknown>
    expect(opts.detached).toBe(true)
    expect(opts.shell).toBe(false)
    expect(opts.windowsHide).toBe(true)
  })

  it('keeps a terminal-attached child in the foreground group on POSIX', async () => {
    const mod = await loadFor('linux')
    isattyMock.mockReturnValue(true)
    mod.spawnTree('node', ['repl.js'], { stdio: 'inherit' })
    expect((spawnMock.mock.calls[0]?.[2] as Record<string, unknown>).detached).toBe(false)
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
