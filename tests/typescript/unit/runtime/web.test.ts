// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the web console launcher's stack-readiness preflight.

import { dirname, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
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
import { CARACAL_VERSION } from '../../../../apps/runtime/src/runtime/version.gen.ts'

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

  it('prints usage and exits for help and for unknown options', async () => {
    await expect(webCommand(['--help'])).rejects.toThrow('exit:0')
    expect(output()).toContain('Usage:')
    expect(output()).toContain('--allow-offline')

    stdout.mockClear()
    stderr.mockClear()
    await expect(webCommand(['--frobnicate'])).rejects.toThrow('exit:0')
    expect(output()).toContain("unknown option '--frobnicate'")
  })

  it('rejects non-positive or non-numeric ports', async () => {
    await expect(webCommand(['--web-port', '0'])).rejects.toThrow('exit:0')
    expect(output()).toContain('--web-port must be a positive integer')

    stdout.mockClear()
    stderr.mockClear()
    await expect(webCommand(['--auth-port=console'])).rejects.toThrow('exit:0')
    expect(output()).toContain('--auth-port must be a positive integer')
  })

  it('wires custom ports through the vite args and backend env without touching the packaged container', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response)

    await webCommand(['--web-port=4101', '--auth-port', '4102'])

    const viteSpawn = spawnMock.mock.calls.find((call) => (call[1] as string[]).includes('vite'))
    expect(viteSpawn).toBeDefined()
    expect(viteSpawn![1]).toContain('4101')
    const backendSpawn = spawnMock.mock.calls.find((call) => (call[1] as string[]).includes('apps/auth'))
    expect(backendSpawn).toBeDefined()
    expect((backendSpawn![2] as { env: NodeJS.ProcessEnv }).env.CARACAL_AUTH_PORT).toBe('4102')
    expect((backendSpawn![2] as { env: NodeJS.ProcessEnv }).env.CARACAL_WEB_ORIGIN).toBe('http://localhost:4101')
    expect((backendSpawn![2] as { env: NodeJS.ProcessEnv }).env.CARACAL_VERSION).toBe(CARACAL_VERSION)
    // A custom web port leaves the packaged console container alone.
    const stopped = spawnSyncMock.mock.calls.find((call) => call[0] === 'docker' && (call[1] as string[])[0] === 'stop')
    expect(stopped).toBeUndefined()
    expect(output()).toContain('http://localhost:4101')
  })

  it('never overrides an operator-provided CARACAL_VERSION for the backend', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response)
    process.env.CARACAL_VERSION = 'v0.3.0'

    await webCommand(['--web-port=4101', '--auth-port', '4102'])

    const backendSpawn = spawnMock.mock.calls.find((call) => (call[1] as string[]).includes('apps/auth'))
    expect(backendSpawn).toBeDefined()
    expect((backendSpawn![2] as { env: NodeJS.ProcessEnv }).env.CARACAL_VERSION).toBe('v0.3.0')
  })

  it('builds both apps first and serves the production build with --build', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response)

    await webCommand(['--build'])

    const builds = spawnSyncMock.mock.calls.filter((call) => Array.isArray(call[1]) && (call[1] as string[]).includes('build'))
    expect(builds.some((call) => (call[1] as string[]).includes('apps/web'))).toBe(true)
    expect(builds.some((call) => (call[1] as string[]).includes('apps/auth'))).toBe(true)
    const viteSpawn = spawnMock.mock.calls.find((call) => (call[1] as string[]).includes('vite'))
    expect(viteSpawn![1]).toContain('preview')
    expect(output()).toContain('production build')
  })

  it('stops with the build exit code when the web UI build fails', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response)
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('build') && args.includes('apps/web')) {
        return { status: 2, stdout: '' }
      }
      if (cmd === 'docker' && Array.isArray(args) && args.includes('ps')) {
        return { status: 0, stdout: '\n' }
      }
      return { status: 0, stdout: '/usr/bin/pnpm\n' }
    })

    await expect(webCommand(['--build'])).rejects.toThrow('exit:2')
    expect(output()).toContain('production build failed')
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('webCommand log aggregation', () => {
  let stdout: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>
  let children: Array<{ tagStreams: PassThrough[]; args: string[] }>

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...ORIG_ENV, CARACAL_REPO_ROOT: REPO_ROOT, npm_execpath: 'pnpm.cjs' }
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    children = []
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const out = new PassThrough()
      const err = new PassThrough()
      children.push({ tagStreams: [out, err], args })
      return { on: vi.fn(), once: vi.fn(), kill: vi.fn(), stdout: out, stderr: err, exitCode: null, signalCode: null }
    })
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'docker' && Array.isArray(args) && args.includes('ps')) return { status: 0, stdout: '\n' }
      return { status: 0, stdout: '/usr/bin/pnpm\n' }
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true } as Response))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    process.env = { ...ORIG_ENV }
  })

  function output(): string {
    return [...stdout.mock.calls, ...stderr.mock.calls].map((c) => String(c[0])).join('')
  }

  async function writeToBackend(chunks: string[]): Promise<void> {
    await webCommand([])
    const backend = children.find((child) => child.args.includes('apps/auth'))
    expect(backend).toBeDefined()
    for (const chunk of chunks) backend!.tagStreams[0]!.write(chunk)
    await new Promise((resolve) => setImmediate(resolve))
  }

  it('renders structured records as source-tagged compact lines, dropping identity noise', async () => {
    const record = {
      level: 'info',
      time: '2026-07-05T10:00:00.000Z',
      msg: 'listening',
      service: 'auth',
      pid: 1234,
      port: 3002,
    }
    await writeToBackend([JSON.stringify(record) + '\n'])
    const out = output()
    expect(out).toContain('listening')
    expect(out).toContain('port=3002')
    expect(out).toContain('10:00:00')
    expect(out).not.toContain('pid=1234')
    expect(out).toContain('bff')
  })

  it('scrubs connection-string credentials from every rendered line', async () => {
    await writeToBackend(['connected to postgres://caracal:supersecret@localhost:5432/caracal\n'])
    const out = output()
    expect(out).toContain('postgres://caracal:***@localhost')
    expect(out).not.toContain('supersecret')
  })

  it('reassembles records split across stream chunks and passes plain text through verbatim', async () => {
    const record = JSON.stringify({ level: 'warn', time: '2026-07-05T10:00:01.000Z', msg: 'slow query', durationMs: 1913 })
    const half = Math.floor(record.length / 2)
    await writeToBackend([record.slice(0, half), record.slice(half) + '\nplain vite banner\n'])
    const out = output()
    expect(out).toContain('slow query')
    expect(out).toContain('durationMs=1913')
    expect(out).toContain('plain vite banner')
  })

  it('renders long field values truncated so one record cannot flood the terminal', async () => {
    const record = JSON.stringify({ level: 'info', time: '2026-07-05T10:00:02.000Z', msg: 'payload', blob: 'x'.repeat(400) })
    await writeToBackend([record + '\n'])
    const out = output()
    expect(out).toContain('…')
    expect(out).not.toContain('x'.repeat(400))
  })

  it('flushes a trailing unterminated line when the stream ends', async () => {
    await webCommand([])
    const backend = children.find((child) => child.args.includes('apps/auth'))!
    backend.tagStreams[0]!.write('final line without newline')
    backend.tagStreams[0]!.end()
    await new Promise((resolve) => setImmediate(resolve))
    expect(output()).toContain('final line without newline')
  })
})
