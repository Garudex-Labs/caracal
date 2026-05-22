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
const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: 'control-container-id\n' })))
const controlEnabledMock = vi.hoisted(() => vi.fn(() => false))
const readControlStateMock = vi.hoisted(() => vi.fn(() => undefined))
const setControlEnabledMock = vi.hoisted(() => vi.fn())
const setControlMountedMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../packages/engine/src/run.js', () => ({
  runExec: runExecMock,
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}))

vi.mock('../../../../packages/engine/src/controlState.js', () => ({
  controlRuntimeSettings: () => ({
    service: 'control',
    profile: 'control',
    port: Number(process.env.CONTROL_PORT ?? 8087),
    endpoint: `http://localhost:${Number(process.env.CONTROL_PORT ?? 8087)}`,
    healthUrl: `http://localhost:${Number(process.env.CONTROL_PORT ?? 8087)}/health`,
    readyUrl: `http://localhost:${Number(process.env.CONTROL_PORT ?? 8087)}/ready`,
    invokeUrl: `http://localhost:${Number(process.env.CONTROL_PORT ?? 8087)}/v1/control/invoke`,
    bind: '127.0.0.1',
  }),
  controlGateFile: () => '/tmp/caracal/control/enabled',
  controlStateFile: () => '/tmp/caracal/control.json',
  ensureControlGateDir: () => '/tmp/caracal/control',
  isControlEnabled: controlEnabledMock,
  readControlState: readControlStateMock,
  setControlEnabled: setControlEnabledMock,
  setControlMounted: setControlMountedMock,
}))

vi.mock('../../../../packages/engine/src/controlAccess.js', () => ({
  authorizeControlManagementAccess: vi.fn(),
}))

import {
  applyControlLifecycleAction,
  composeRun,
  controlServiceStatus,
  defaultServiceProbes,
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
  spawnSyncMock.mockReturnValue({ status: 0, stdout: 'control-container-id\n' })
  controlEnabledMock.mockReset()
  readControlStateMock.mockReset()
  setControlEnabledMock.mockReset()
  setControlMountedMock.mockReset()
  delete process.env.CONTROL_PORT
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

  it('adds the control profile only when control runtime state is enabled', () => {
    controlEnabledMock.mockReturnValue(true)

    stackDown({ paths: paths('stable', []), args: [], env: { CARACAL_MODE: 'stable' } })

    expect(calls[0].argv).toEqual([
      'docker',
      'compose',
      '-f',
      join(dir, 'stable.yml'),
      '--profile',
      'control',
      'down',
    ])
    expect(calls[0].env).toEqual({
      CARACAL_MODE: 'stable',
      CARACAL_ENGINE_CONTROL_ENABLED: 'true',
      CARACAL_CONTROL_STATE_DIR: '/tmp/caracal/control',
    })
  })

  it('rejects direct Control service targets from stack commands', () => {
    expect(() => stackUp({
      paths: paths('stable', []),
      args: ['control'],
      env: { CARACAL_MODE: 'stable' },
    })).toThrow(/managed only through caracal-cli control/)

    expect(() => stackDown({
      paths: paths('stable', []),
      args: ['--profile', 'api,control'],
      env: { CARACAL_MODE: 'stable' },
    })).toThrow(/managed only through caracal-cli control/)
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

describe('stack compose helpers', () => {
  it('composeRun includes the control profile only when control is enabled', async () => {
    const envFile = join(dir, 'caracal.env')
    writeFileSync(envFile, '# operator env\n')

    controlEnabledMock.mockReturnValueOnce(true)
    await composeRun({
      paths: paths('stable', [envFile]),
      args: ['ps'],
      env: { CARACAL_MODE: 'stable' },
    }).exitCode

    controlEnabledMock.mockReturnValueOnce(false)
    await composeRun({
      paths: paths('stable', [envFile]),
      args: ['ps'],
      env: { CARACAL_MODE: 'stable' },
    }).exitCode

    expect(calls[0].argv).toEqual([
      'docker',
      'compose',
      '--env-file',
      envFile,
      '-f',
      join(dir, 'stable.yml'),
      '--profile',
      'control',
      'ps',
    ])
    expect(calls[0].env).toEqual({
      CARACAL_MODE: 'stable',
      CARACAL_ENGINE_CONTROL_ENABLED: 'true',
      CARACAL_CONTROL_STATE_DIR: '/tmp/caracal/control',
    })
    expect(calls[1].argv).toEqual([
      'docker',
      'compose',
      '--env-file',
      envFile,
      '-f',
      join(dir, 'stable.yml'),
      'ps',
    ])
  })

  it('defaultServiceProbes includes control only when runtime state is enabled', () => {
    process.env.CONTROL_PORT = '9100'
    readControlStateMock.mockReturnValueOnce({
      mounted: true,
      enabled: true,
      managedBy: 'engine',
      updatedAt: '2026-05-21T00:00:00.000Z',
      service: 'control',
      profile: 'control',
      port: 9100,
      endpoint: 'http://localhost:9100',
      healthUrl: 'http://localhost:9100/health',
      readyUrl: 'http://localhost:9100/ready',
      invokeUrl: 'http://localhost:9100/v1/control/invoke',
      bind: '127.0.0.1',
    })
    const enabled = defaultServiceProbes('/tmp/home')
    expect(enabled.some((p) => p.name === 'control' && p.port === 9100)).toBe(true)

    readControlStateMock.mockReturnValueOnce({
      mounted: true,
      enabled: false,
      mountedAt: '2026-05-21T00:00:00.000Z',
      managedBy: 'engine',
      updatedAt: '2026-05-21T00:00:00.000Z',
      service: 'control',
      profile: 'control',
      port: 9100,
      endpoint: 'http://localhost:9100',
      healthUrl: 'http://localhost:9100/health',
      readyUrl: 'http://localhost:9100/ready',
      invokeUrl: 'http://localhost:9100/v1/control/invoke',
      bind: '127.0.0.1',
    })
    const mountedDisabled = defaultServiceProbes('/tmp/home')
    expect(mountedDisabled.some((p) => p.name === 'control')).toBe(false)

    readControlStateMock.mockReturnValueOnce(undefined)
    const disabled = defaultServiceProbes('/tmp/home')
    expect(disabled.some((p) => p.name === 'control')).toBe(false)
    delete process.env.CONTROL_PORT
  })

  it('reports structured control status for disabled and enabled states', async () => {
    readControlStateMock.mockReturnValueOnce(undefined)
    await expect(controlServiceStatus({ home: '/tmp/home' })).resolves.toMatchObject({
      state: 'unmounted',
      service: 'unmounted',
      mounted: false,
      enabled: false,
      marker: '/tmp/caracal/control.json',
      endpoint: 'http://localhost:8087',
      invokeUrl: 'http://localhost:8087/v1/control/invoke',
      profile: 'control',
      lifecycle: 'unmounted',
      optimization: 'control container is removed; no control background process is kept running',
    })

    readControlStateMock.mockReturnValueOnce({
      mounted: true,
      enabled: true,
      managedBy: 'engine',
      updatedAt: '2026-05-21T00:00:00.000Z',
      service: 'control',
      profile: 'control',
      port: 8087,
      endpoint: 'http://localhost:8087',
      healthUrl: 'http://localhost:8087/health',
      readyUrl: 'http://localhost:8087/ready',
      invokeUrl: 'http://localhost:8087/v1/control/invoke',
      bind: '127.0.0.1',
    })
    mkdirSync('/tmp/caracal/control', { recursive: true })
    writeFileSync('/tmp/caracal/control/enabled', 'enabled\n')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response)
    try {
      await expect(controlServiceStatus({ home: '/tmp/home' })).resolves.toMatchObject({
        state: 'enabled',
        service: 'ok',
        mounted: true,
        enabled: true,
        marker: '/tmp/caracal/control.json',
        endpoint: 'http://localhost:8087',
        invokeUrl: 'http://localhost:8087/v1/control/invoke',
        profile: 'control',
        detail: '200',
        lifecycle: 'mounted and enabled',
      })
      expect(fetchSpy).toHaveBeenCalledWith('http://localhost:8087/ready', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    } finally {
      fetchSpy.mockRestore()
      rmSync('/tmp/caracal', { recursive: true, force: true })
    }
  })

  it('clears stale mounted state when the control container is absent', async () => {
    const stable = paths('stable', [])
    readControlStateMock.mockReturnValue({
      mounted: true,
      enabled: false,
      mountedAt: '2026-05-21T00:00:00.000Z',
      managedBy: 'engine',
      updatedAt: '2026-05-21T00:00:00.000Z',
      service: 'control',
      profile: 'control',
      port: 8087,
      endpoint: 'http://localhost:8087',
      healthUrl: 'http://localhost:8087/health',
      readyUrl: 'http://localhost:8087/ready',
      invokeUrl: 'http://localhost:8087/v1/control/invoke',
      bind: '127.0.0.1',
    })
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '' })

    await expect(controlServiceStatus({
      home: '/tmp/home',
      paths: stable,
      env: { CARACAL_MODE: 'stable' },
    })).resolves.toMatchObject({
      state: 'unmounted',
      service: 'unmounted',
      mounted: false,
      enabled: false,
      detail: 'not mounted',
    })

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'docker',
      [
        'compose',
        '-f',
        join(dir, 'stable.yml'),
        '--profile',
        'control',
        'ps',
        '--all',
        '-q',
        'control',
      ],
      expect.objectContaining({ cwd: dir }),
    )
    expect(setControlMountedMock).toHaveBeenCalledWith(false, false, { home: '/tmp/home' })
  })

  it('clears disabled mounted state that lacks explicit mount provenance', async () => {
    const stable = paths('stable', [])
    readControlStateMock.mockReturnValue({
      mounted: true,
      enabled: false,
      managedBy: 'engine',
      updatedAt: '2026-05-21T00:00:00.000Z',
      service: 'control',
      profile: 'control',
      port: 8087,
      endpoint: 'http://localhost:8087',
      healthUrl: 'http://localhost:8087/health',
      readyUrl: 'http://localhost:8087/ready',
      invokeUrl: 'http://localhost:8087/v1/control/invoke',
      bind: '127.0.0.1',
    })

    await expect(controlServiceStatus({
      home: '/tmp/home',
      paths: stable,
      env: { CARACAL_MODE: 'stable' },
    })).resolves.toMatchObject({
      state: 'unmounted',
      mounted: false,
      enabled: false,
    })

    expect(spawnSyncMock).not.toHaveBeenCalled()
    expect(setControlMountedMock).toHaveBeenCalledWith(false, false, { home: '/tmp/home' })
  })

  it('applies control lifecycle actions only through managed compose environment', async () => {
    const stable = paths('stable', [])
    readControlStateMock
      .mockReturnValueOnce({
        mounted: true,
        enabled: false,
        managedBy: 'engine',
        updatedAt: '2026-05-21T00:00:00.000Z',
        service: 'control',
        profile: 'control',
        port: 8087,
        endpoint: 'http://localhost:8087',
        healthUrl: 'http://localhost:8087/health',
        readyUrl: 'http://localhost:8087/ready',
        invokeUrl: 'http://localhost:8087/v1/control/invoke',
        bind: '127.0.0.1',
      })
      .mockReturnValueOnce({
        mounted: true,
        enabled: true,
        managedBy: 'engine',
        updatedAt: '2026-05-21T00:00:00.000Z',
        service: 'control',
        profile: 'control',
        port: 8087,
        endpoint: 'http://localhost:8087',
        healthUrl: 'http://localhost:8087/health',
        readyUrl: 'http://localhost:8087/ready',
        invokeUrl: 'http://localhost:8087/v1/control/invoke',
        bind: '127.0.0.1',
      })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response)
    try {
      await expect(applyControlLifecycleAction({
        paths: stable,
        action: 'enable',
        env: { CARACAL_MODE: 'stable' },
      })).resolves.toMatchObject({
        action: 'enable',
        state: 'enabled',
        service: 'running',
        mounted: true,
        enabled: true,
        marker: '/tmp/caracal/control.json',
        endpoint: 'http://localhost:8087',
        invokeUrl: 'http://localhost:8087/v1/control/invoke',
        profile: 'control',
        lifecycle: 'mounted and enabled',
        optimization: 'uses the existing stack services; no dedicated persistent volume is created',
      })

      await expect(applyControlLifecycleAction({
        paths: stable,
        action: 'disable',
        env: { CARACAL_MODE: 'stable' },
      })).resolves.toMatchObject({
        action: 'disable',
        state: 'disabled',
        service: 'gated',
        mounted: true,
        enabled: false,
        marker: '/tmp/caracal/control.json',
        endpoint: 'http://localhost:8087',
        invokeUrl: 'http://localhost:8087/v1/control/invoke',
        profile: 'control',
        lifecycle: 'mounted but disabled',
        optimization: 'runtime remains loaded; the Control endpoint is blocked by the local gate',
      })
    } finally {
      fetchSpy.mockRestore()
    }

    expect(setControlEnabledMock).toHaveBeenNthCalledWith(1, true)
    expect(setControlEnabledMock).toHaveBeenNthCalledWith(2, false)
    expect(calls).toEqual([])
  })

  it('does not mount runtime as a side effect of endpoint enable', async () => {
    const stable = paths('stable', [])
    readControlStateMock.mockReturnValue(undefined)

    await expect(applyControlLifecycleAction({
      paths: stable,
      action: 'enable',
      env: { CARACAL_MODE: 'stable' },
    })).rejects.toThrow(/not mounted/)

    expect(calls).toEqual([])
    expect(setControlEnabledMock).not.toHaveBeenCalled()
  })

  it('rolls back endpoint enable when the ready gate stays closed', async () => {
    const stable = paths('stable', [])
    readControlStateMock.mockReturnValue({
      mounted: true,
      enabled: false,
      mountedAt: '2026-05-21T00:00:00.000Z',
      managedBy: 'engine',
      updatedAt: '2026-05-21T00:00:00.000Z',
      service: 'control',
      profile: 'control',
      port: 8087,
      endpoint: 'http://localhost:8087',
      healthUrl: 'http://localhost:8087/health',
      readyUrl: 'http://localhost:8087/ready',
      invokeUrl: 'http://localhost:8087/v1/control/invoke',
      bind: '127.0.0.1',
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response)
    try {
      await expect(applyControlLifecycleAction({
        paths: stable,
        action: 'enable',
        env: { CARACAL_MODE: 'stable' },
      })).rejects.toThrow(/gate did not open/)
    } finally {
      fetchSpy.mockRestore()
    }

    expect(setControlEnabledMock).toHaveBeenNthCalledWith(1, true)
    expect(setControlEnabledMock).toHaveBeenNthCalledWith(2, false)
    expect(calls).toEqual([])
  })

  it('mounts and unmounts control runtime as long-term lifecycle actions', async () => {
    const stable = paths('stable', [])
    readControlStateMock
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({
        mounted: true,
        enabled: false,
        managedBy: 'engine',
        updatedAt: '2026-05-21T00:00:00.000Z',
        service: 'control',
        profile: 'control',
        port: 8087,
        endpoint: 'http://localhost:8087',
        healthUrl: 'http://localhost:8087/health',
        readyUrl: 'http://localhost:8087/ready',
        invokeUrl: 'http://localhost:8087/v1/control/invoke',
        bind: '127.0.0.1',
      })

    await expect(applyControlLifecycleAction({
      paths: stable,
      action: 'mount',
      env: { CARACAL_MODE: 'stable' },
    })).resolves.toMatchObject({
      action: 'mount',
      state: 'disabled',
      service: 'gated',
      mounted: true,
      enabled: false,
      lifecycle: 'mounted but disabled',
    })

    await expect(applyControlLifecycleAction({
      paths: stable,
      action: 'unmount',
      env: { CARACAL_MODE: 'stable' },
    })).resolves.toMatchObject({
      action: 'unmount',
      state: 'unmounted',
      service: 'removed',
      mounted: false,
      enabled: false,
      lifecycle: 'unmounted',
    })

    expect(setControlMountedMock).toHaveBeenNthCalledWith(1, true, false)
    expect(setControlMountedMock).toHaveBeenNthCalledWith(2, false, false)
    expect(calls[0].env).toEqual({
      CARACAL_MODE: 'stable',
      CARACAL_ENGINE_CONTROL_ENABLED: 'true',
      CARACAL_CONTROL_STATE_DIR: '/tmp/caracal/control',
    })
    expect(calls[0].argv).toEqual([
      'docker',
      'compose',
      '-f',
      join(dir, 'stable.yml'),
      '--profile',
      'control',
      'up',
      '-d',
      'control',
    ])
    expect(typeof calls[0].onLine).toBe('function')
    expect(calls[1].env).toEqual({
      CARACAL_MODE: 'stable',
      CARACAL_ENGINE_CONTROL_ENABLED: 'true',
      CARACAL_CONTROL_STATE_DIR: '/tmp/caracal/control',
    })
    expect(calls[1].argv).toEqual([
      'docker',
      'compose',
      '-f',
      join(dir, 'stable.yml'),
      '--profile',
      'control',
      'rm',
      '-sf',
      'control',
    ])
    expect(typeof calls[1].onLine).toBe('function')
  })

  it('does not remount control when runtime is already mounted', async () => {
    const stable = paths('stable', [])
    readControlStateMock.mockReturnValue({
      mounted: true,
      enabled: false,
      managedBy: 'engine',
      updatedAt: '2026-05-21T00:00:00.000Z',
      service: 'control',
      profile: 'control',
      port: 8087,
      endpoint: 'http://localhost:8087',
      healthUrl: 'http://localhost:8087/health',
      readyUrl: 'http://localhost:8087/ready',
      invokeUrl: 'http://localhost:8087/v1/control/invoke',
      bind: '127.0.0.1',
    })

    await expect(applyControlLifecycleAction({
      paths: stable,
      action: 'mount',
      env: { CARACAL_MODE: 'stable' },
    })).resolves.toMatchObject({
      action: 'mount',
      state: 'disabled',
      service: 'gated',
      mounted: true,
      enabled: false,
    })

    expect(calls).toEqual([])
    expect(setControlMountedMock).not.toHaveBeenCalled()
  })
})
