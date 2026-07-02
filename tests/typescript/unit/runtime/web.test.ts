// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the web console launcher's stack-readiness preflight.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const spawnSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}))

import { webCommand } from '../../../../apps/runtime/src/commands/web.ts'

// Repo root resolved from this test's own location (tests/typescript/unit/runtime), so the
// preflight finds apps/web and apps/auth regardless of the runner's working directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

const ORIG_ENV = { ...process.env }

describe('webCommand stack preflight', () => {
  let stdout: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>
  let exit: ReturnType<typeof vi.spyOn>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    // The launcher only runs inside the workspace; point CARACAL_REPO_ROOT at this
    // repo so apps/web and apps/auth resolve. Pinning npm_execpath keeps pnpm
    // resolution on the portable Node + pnpm CLI module branch, so the preflight
    // never depends on the host PATH or platform shim layout.
    process.env = { ...ORIG_ENV, CARACAL_REPO_ROOT: REPO_ROOT, npm_execpath: 'pnpm.cjs' }
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    // A child handle that never resolves; the launcher only spawns when it proceeds.
    spawnMock.mockReturnValue({ on: vi.fn(), kill: vi.fn() })
    // Default synchronous spawns: `docker compose ps web` resolves a running container id (so the
    // launcher exercises the yield path), every other call (pnpm, docker stop/start) succeeds.
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'docker' && Array.isArray(args) && args.includes('ps')) {
        return { status: 0, stdout: 'webcontainerid\n' }
      }
      return { status: 0, stdout: '/usr/bin/pnpm\n' }
    })
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    process.env = { ...ORIG_ENV }
  })

  function output(): string {
    return [...stdout.mock.calls, ...stderr.mock.calls].map((c) => String(c[0])).join('')
  }

  it('refuses to launch and points to `caracal up` when the stack is down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(webCommand([])).rejects.toThrow('exit:1')

    const out = output()
    expect(out).toContain('the Caracal stack is not running')
    expect(out).toContain('caracal up')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('launches the console when the control plane is reachable', async () => {
    // Both /health probes (api, coordinator) resolve ok.
    fetchMock.mockResolvedValue({ ok: true } as Response)

    await webCommand([])

    expect(exit).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledTimes(2)
    // Each service must be spawned as a killable tree: detached into its own process
    // group on POSIX so a single Ctrl+C reaches every descendant, attached on Windows
    // where taskkill /T reaps the tree instead.
    for (const call of spawnMock.mock.calls) {
      expect(call[2]).toMatchObject({ detached: process.platform !== 'win32' })
    }
    expect(output()).toContain('Caracal web console')
  })

  it('stops the packaged web container and takes over the port when one is running', async () => {
    // The stack is up and a packaged web container is running; the launcher must stop that
    // container so the development console can bind 3001, and say so in the banner.
    fetchMock.mockResolvedValue({ ok: true } as Response)

    await webCommand([])

    const resolvedWeb = spawnSyncMock.mock.calls.find(
      (call) => call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('ps') && call[1].includes('web'),
    )
    const stoppedContainer = spawnSyncMock.mock.calls.find(
      (call) => call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'stop',
    )
    expect(resolvedWeb).toBeDefined()
    expect(stoppedContainer).toBeDefined()
    expect(output()).toContain('Packaged web console stopped to free port 3001')
  })

  it('does not stop anything when no packaged web container is running', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response)
    // `docker compose ps web` resolves no container, so there is nothing to yield.
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'docker' && Array.isArray(args) && args.includes('ps')) {
        return { status: 0, stdout: '\n' }
      }
      return { status: 0, stdout: '/usr/bin/pnpm\n' }
    })

    await webCommand([])

    const stoppedContainer = spawnSyncMock.mock.calls.find(
      (call) => call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'stop',
    )
    expect(stoppedContainer).toBeUndefined()
    expect(output()).not.toContain('Packaged web console stopped')
  })

  it('warns but still launches when only the Coordinator is down', async () => {
    fetchMock.mockImplementation((url: string | URL) => {
      const target = String(url)
      if (target.includes('4000')) return Promise.reject(new Error('ECONNREFUSED'))
      return Promise.resolve({ ok: true } as Response)
    })

    await webCommand([])

    expect(exit).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalled()
    expect(output()).toContain('Coordinator is not responding')
  })

  it('bypasses the preflight with --allow-offline', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    await webCommand(['--allow-offline'])

    expect(exit).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalled()
  })
})
