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
  spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn(), kill: vi.fn(), pid: 4321 })
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

describe('deferRunningExecutableRemoval', () => {
  it('schedules the running Windows executable for removal after exit', async () => {
    process.env.SystemRoot = String.raw`C:\Windows`
    const mod = await loadFor('win32')
    expect(
      mod.deferRunningExecutableRemoval(
        String.raw`C:\Program Files\Caracal\caracal.exe`,
        String.raw`c:\program files\caracal\CARACAL.EXE`,
        1234,
      ),
    ).toBe(true)

    const [command, args, options] = spawnSyncMock.mock.calls[0] as [string, string[], Record<string, unknown>]
    expect(command).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)
    expect(args.slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    const launcher = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
    expect(launcher).toContain('Start-Process')
    expect(launcher).toContain('-WindowStyle Hidden')
    const cleanup = /'-EncodedCommand', '([^']+)'/.exec(launcher)?.[1]
    expect(cleanup).toBeDefined()
    const script = Buffer.from(cleanup!, 'base64').toString('utf16le')
    expect(script).toContain('Wait-Process -Id 1234')
    expect(script).toContain("Remove-Item -LiteralPath 'C:\\Program Files\\Caracal\\caracal.exe' -Force")
    expect(script).toContain('Start-Sleep -Milliseconds 100')
    expect(options).toMatchObject({ stdio: 'ignore', windowsHide: true })
  })

  it('does not defer a different executable or any POSIX executable', async () => {
    let mod = await loadFor('win32')
    expect(mod.deferRunningExecutableRemoval('C:\\caracal.exe', 'C:\\node.exe', 1234)).toBe(false)
    mod = await loadFor('linux')
    expect(mod.deferRunningExecutableRemoval('/usr/local/bin/caracal', '/usr/local/bin/caracal', 1234)).toBe(false)
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })
})

describe('removeWindowsUserPathEntry', () => {
  it('removes the install directory from the persistent Windows user PATH', async () => {
    process.env.SystemRoot = String.raw`C:\Windows`
    const mod = await loadFor('win32')

    expect(mod.removeWindowsUserPathEntry(String.raw`C:\Users\O'Brien\Programs\caracal`)).toBe(true)

    const [, args] = spawnSyncMock.mock.calls[0] as [string, string[]]
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
    expect(script).toContain("GetEnvironmentVariable('Path', 'User')")
    expect(script).toContain(String.raw`C:\Users\O''Brien\Programs\caracal`)
    expect(script).toContain("SetEnvironmentVariable('Path', $next, 'User')")
  })

  it('does not mutate PATH on POSIX', async () => {
    const mod = await loadFor('linux')
    expect(mod.removeWindowsUserPathEntry('/usr/local/bin')).toBe(false)
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })
})
