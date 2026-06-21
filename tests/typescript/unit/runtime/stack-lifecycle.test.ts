// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for stack lifecycle docker compose command construction.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StackPaths } from '../../../../packages/engine/src/stack.ts'

const runExecMock = vi.hoisted(() => vi.fn())
const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: '' })))
const controlEnabledMock = vi.hoisted(() => vi.fn(() => false))
const setControlEnabledMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../packages/engine/src/run.js', () => ({
  runExec: runExecMock,
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}))

vi.mock('../../../../packages/engine/src/controlState.js', () => ({
  controlRuntimeSettings: () => ({
    port: 3000,
    endpoint: 'http://localhost:3000',
    healthUrl: 'http://localhost:3000/health',
    readyUrl: 'http://localhost:3000/ready',
    invokeUrl: 'http://localhost:3000/v1/control/invoke',
    bind: '127.0.0.1',
  }),
  controlGateFile: () => '/tmp/caracal/control/enabled',
  isControlEnabled: controlEnabledMock,
  setControlEnabled: setControlEnabledMock,
}))

vi.mock('../../../../packages/engine/src/controlAccess.js', () => ({
  authorizeControlManagementAccess: vi.fn(),
}))

import {
  applyControlLifecycleAction,
  controlServiceStatus,
  stackDown,
  stackUp,
} from '../../../../packages/engine/src/stack.ts'

let dir: string
let calls: Array<{ argv: string[]; env?: Record<string, string | undefined>; cwd?: string; onLine?: unknown }>

function paths(mode: StackPaths['mode'], envFiles: string[]): StackPaths {
  return {
    composeFile: join(dir, `${mode}.yml`),
    envFiles,
    cwd: dir,
    mode,
    secretsDir: join(dir, 'secrets'),
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caracal-stack-'))
  calls = []
  runExecMock.mockImplementation((opts: { argv: string[]; env?: Record<string, string | undefined>; cwd?: string; onLine?: unknown }) => {
    const call: { argv: string[]; env?: Record<string, string | undefined>; cwd?: string; onLine?: unknown } = { argv: opts.argv, env: opts.env, cwd: opts.cwd }
    if (opts.onLine) call.onLine = opts.onLine
    calls.push(call)
    return { dispose: vi.fn(), exitCode: Promise.resolve(0) }
  })
  controlEnabledMock.mockReturnValue(false)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync('/tmp/caracal', { recursive: true, force: true })
  runExecMock.mockReset()
  spawnSyncMock.mockReset()
  spawnSyncMock.mockReturnValue({ status: 0, stdout: '' })
  controlEnabledMock.mockReset()
  setControlEnabledMock.mockReset()
})

describe('stack lifecycle compose commands', () => {
  it('starts dev stacks with build and removes one-shot containers after success', async () => {
    const devEnv = join(dir, 'dev.env')
    const localEnv = join(dir, 'local.env')
    writeFileSync(devEnv, 'CARACAL_MODE=dev\n')
    writeFileSync(localEnv, 'LOG_LEVEL=debug\n')

    const handle = stackUp({
      paths: paths('dev', [devEnv, localEnv]),
      args: ['api'],
      env: { CARACAL_MODE: 'dev', CARACAL_DEV_SHA: 'abc123' },
    })
    await expect(handle.exitCode).resolves.toBe(0)

    expect(calls[0]).toEqual({
      argv: [
        'docker',
        'compose',
        '--env-file',
        devEnv,
        '--env-file',
        localEnv,
        '-f',
        join(dir, 'dev.yml'),
        'up',
        '-d',
        '--build',
        '--remove-orphans',
        'api',
      ],
      env: { CARACAL_MODE: 'dev', CARACAL_DEV_SHA: 'abc123' },
      cwd: dir,
    })
    expect(calls[1].argv).toEqual([
      'docker',
      'compose',
      '--env-file',
      devEnv,
      '--env-file',
      localEnv,
      '-f',
      join(dir, 'dev.yml'),
      'rm',
      '-f',
    ])
  })

  it('starts rc and stable stacks without build and skips missing env files', async () => {
    for (const mode of ['rc', 'stable'] as const) {
      calls = []
      const envFile = join(dir, `${mode}.env`)
      writeFileSync(envFile, `CARACAL_MODE=${mode}\n`)

      const handle = stackUp({
        paths: paths(mode, [envFile, join(dir, 'missing.env')]),
        args: [],
        env: { CARACAL_MODE: mode, CARACAL_VERSION: '1.0.0' },
      })
      await expect(handle.exitCode).resolves.toBe(0)

      expect(calls[0].argv).toEqual([
        'docker',
        'compose',
        '--env-file',
        envFile,
        '-f',
        join(dir, `${mode}.yml`),
        'up',
        '-d',
        '--remove-orphans',
      ])
      expect(calls[0].argv).not.toContain('--build')
      expect(calls[1].argv).toEqual([
        'docker',
        'compose',
        '--env-file',
        envFile,
        '-f',
        join(dir, `${mode}.yml`),
        'rm',
        '-f',
      ])
    }
  })

  it('does not remove one-shot containers when startup fails', async () => {
    runExecMock.mockImplementationOnce((opts: { argv: string[]; env?: Record<string, string | undefined>; cwd?: string; onLine?: unknown }) => {
      const call: { argv: string[]; env?: Record<string, string | undefined>; cwd?: string; onLine?: unknown } = { argv: opts.argv, env: opts.env, cwd: opts.cwd }
      if (opts.onLine) call.onLine = opts.onLine
      calls.push(call)
      return { dispose: vi.fn(), exitCode: Promise.resolve(1) }
    })

    const handle = stackUp({ paths: paths('stable', []), args: [], env: { CARACAL_MODE: 'stable' } })

    await expect(handle.exitCode).resolves.toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('stops stacks with operator env files and caller arguments', () => {
    const envFile = join(dir, 'caracal.env')
    writeFileSync(envFile, '# operator\n')

    stackDown({
      paths: paths('stable', [envFile]),
      args: ['--volumes'],
      env: { CARACAL_MODE: 'stable' },
    })

    expect(calls[0]).toEqual({
      argv: [
        'docker',
        'compose',
        '--env-file',
        envFile,
        '-f',
        join(dir, 'stable.yml'),
        'down',
        '--volumes',
      ],
      env: { CARACAL_MODE: 'stable' },
      cwd: dir,
    })
  })

  it('filters absent env files through the filesystem boundary', () => {
    const envFile = join(dir, 'present.env')
    writeFileSync(envFile, 'LOG_LEVEL=info\n')

    stackDown({ paths: paths('dev', [join(dir, 'missing.env'), envFile]), args: [], env: {} })

    expect(existsSync(envFile)).toBe(true)
    expect(calls[0].argv).toEqual([
      'docker',
      'compose',
      '--env-file',
      envFile,
      '-f',
      join(dir, 'dev.yml'),
      'down',
    ])
  })
})

describe('control lifecycle', () => {
  const home = '/tmp/home'

  it('enables the endpoint by writing the gate and confirming the API health probe', async () => {
    controlEnabledMock.mockReturnValue(true)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response)
    try {
      await expect(applyControlLifecycleAction({ home, action: 'enable' })).resolves.toMatchObject({
        action: 'enable',
        state: 'enabled',
        service: 'ok',
        enabled: true,
        marker: '/tmp/caracal/control/enabled',
        endpoint: 'http://localhost:3000',
        invokeUrl: 'http://localhost:3000/v1/control/invoke',
        lifecycle: 'enabled',
      })
      expect(fetchSpy).toHaveBeenCalledWith('http://localhost:3000/health', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    } finally {
      fetchSpy.mockRestore()
    }
    expect(setControlEnabledMock).toHaveBeenCalledWith(true, { home })
    expect(calls).toEqual([])
  })

  it('rolls back the gate when the API health probe stays closed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, text: async () => '' } as Response)
    try {
      await expect(applyControlLifecycleAction({ home, action: 'enable' })).rejects.toThrow(/could not be confirmed/)
    } finally {
      fetchSpy.mockRestore()
    }
    expect(setControlEnabledMock).toHaveBeenNthCalledWith(1, true, { home })
    expect(setControlEnabledMock).toHaveBeenNthCalledWith(2, false, { home })
    expect(calls).toEqual([])
  })

  it('disables the endpoint by closing the gate without probing', async () => {
    await expect(applyControlLifecycleAction({ home, action: 'disable' })).resolves.toMatchObject({
      action: 'disable',
      state: 'disabled',
      service: 'gated',
      enabled: false,
      marker: '/tmp/caracal/control/enabled',
      endpoint: 'http://localhost:3000',
      lifecycle: 'disabled',
    })
    expect(setControlEnabledMock).toHaveBeenCalledWith(false, { home })
    expect(calls).toEqual([])
  })

  it('reports a gated status when the endpoint gate is closed', async () => {
    controlEnabledMock.mockReturnValue(false)
    await expect(controlServiceStatus({ home })).resolves.toMatchObject({
      state: 'disabled',
      service: 'gated',
      enabled: false,
      marker: '/tmp/caracal/control/enabled',
      endpoint: 'http://localhost:3000',
      invokeUrl: 'http://localhost:3000/v1/control/invoke',
      detail: 'endpoint disabled',
    })
  })

  it('probes the API health endpoint when the gate is open', async () => {
    controlEnabledMock.mockReturnValue(true)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response)
    try {
      await expect(controlServiceStatus({ home })).resolves.toMatchObject({
        state: 'enabled',
        service: 'ok',
        enabled: true,
        detail: '200',
      })
      expect(fetchSpy).toHaveBeenCalledWith('http://localhost:3000/health', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('marks the endpoint down when the gate is open but the probe fails', async () => {
    controlEnabledMock.mockReturnValue(true)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, text: async () => '' } as Response)
    try {
      await expect(controlServiceStatus({ home })).resolves.toMatchObject({
        state: 'enabled',
        service: 'down',
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
