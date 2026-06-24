// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the web console launcher's stack-readiness preflight.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const spawnSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}))

import { webCommand } from '../../../../apps/runtime/src/commands/web.ts'

const ORIG_ENV = { ...process.env }

describe('webCommand stack preflight', () => {
  let stdout: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>
  let exit: ReturnType<typeof vi.spyOn>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    // The launcher only runs inside the workspace; point CARACAL_REPO_ROOT at this
    // repo so apps/web and apps/auth resolve.
    process.env = { ...ORIG_ENV, CARACAL_REPO_ROOT: process.cwd() }
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    // A child handle that never resolves; the launcher only spawns when it proceeds.
    spawnMock.mockReturnValue({ on: vi.fn(), kill: vi.fn() })
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '/usr/bin/pnpm\n' })
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
    // Each service must be spawned detached so it leads its own process group and a
    // single Ctrl+C can tear down the whole tree (pnpm + vite/tsx descendants).
    for (const call of spawnMock.mock.calls) {
      expect(call[2]).toMatchObject({ detached: true })
    }
    expect(output()).toContain('Caracal web console')
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
