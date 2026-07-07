// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for runtime stack command Docker Compose preflight handling.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engineMocks = vi.hoisted(() => ({
  acquireStackLock: vi.fn(() => vi.fn()),
  appendUpgradeRecord: vi.fn(),
  composeRun: vi.fn(),
  defaultServiceProbes: vi.fn(() => []),
  readRuntimeVersion: vi.fn(() => '2026.06.09'),
  resolveStackPaths: vi.fn(),
  runtimePaths: vi.fn(() => ({ home: '/tmp/caracal' })),
  stackDown: vi.fn(),
  stackStatus: vi.fn(),
  stackUp: vi.fn(),
}))

const spawnSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}))

vi.mock('@caracalai/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@caracalai/engine')>()
  return { ...actual, ...engineMocks }
})

import { downCommand, upCommand, upgradeCommand } from '../../../../apps/runtime/src/commands/stack.ts'

describe('stack commands', () => {
  let stderr = ''
  let stdout = ''
  let xdg: string

  beforeEach(() => {
    vi.clearAllMocks()
    stderr = ''
    stdout = ''
    xdg = mkdtempSync(join(tmpdir(), 'caracal-stack-command-'))
    vi.stubEnv('XDG_CONFIG_HOME', xdg)
    vi.stubEnv('CARACAL_CONFIG', undefined)
    engineMocks.resolveStackPaths.mockReturnValue({
      mode: 'dev',
      composeFile: '/tmp/caracal/docker-compose.yml',
      envFiles: [],
      cwd: '/tmp/caracal',
      secretsDir: '/tmp/caracal-secrets',
    })
    engineMocks.stackDown.mockReturnValue({ dispose: vi.fn(), exitCode: Promise.resolve(0) })
    engineMocks.stackUp.mockReturnValue({ dispose: vi.fn(), exitCode: Promise.resolve(0) })
    engineMocks.composeRun.mockReturnValue({ dispose: vi.fn(), exitCode: Promise.resolve(0) })
    engineMocks.stackStatus.mockResolvedValue([{ name: 'api', port: 3000, url: 'http://localhost:3000/ready', ok: true, detail: '200' }])
    spawnSyncMock.mockReturnValue({ status: 0 })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString()
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(xdg, { recursive: true, force: true })
  })

  it('fails up before spawning when Docker Compose is unavailable', async () => {
    spawnSyncMock.mockReturnValue({ status: 127 })

    await expect(upCommand([])).rejects.toThrow('exit:1')

    expect(stderr).toContain('docker compose is not available; install Docker with the Compose plugin or add docker to PATH')
    expect(engineMocks.stackUp).not.toHaveBeenCalled()
  })

  it('fails down before spawning when Docker Compose is unavailable', async () => {
    spawnSyncMock.mockReturnValue({ status: 127 })

    await expect(downCommand([])).rejects.toThrow('exit:1')

    expect(stderr).toContain('docker compose is not available; install Docker with the Compose plugin or add docker to PATH')
    expect(engineMocks.stackDown).not.toHaveBeenCalled()
  })

  it('fails up before spawning when the Docker daemon is unavailable', async () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'compose') return { status: 0 }
      if (args[0] === 'info') return { status: 1 }
      return { status: 0 }
    })

    await expect(upCommand([])).rejects.toThrow('exit:1')

    expect(stderr).toContain(
      'docker daemon is not reachable; start Docker Desktop (macOS/Windows) or the docker service (Linux) and ensure your user can access the Docker socket',
    )
    expect(engineMocks.stackUp).not.toHaveBeenCalled()
  })

  it('fails up before spawning when BuildKit is unavailable in dev mode', async () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'buildx') return { status: 127 }
      return { status: 0 }
    })

    await expect(upCommand([])).rejects.toThrow('exit:1')

    expect(stderr).toContain('BuildKit is required to build the Caracal stack')
    expect(engineMocks.stackUp).not.toHaveBeenCalled()
  })

  it('runs up when Docker Compose is available', async () => {
    await expect(upCommand(['api'])).rejects.toThrow('exit:0')

    expect(engineMocks.stackUp).toHaveBeenCalledWith(expect.objectContaining({ args: ['api'] }))
    expect(engineMocks.stackStatus).not.toHaveBeenCalled()
  })

  it('reports services ready without creating runtime config after a full stack start', async () => {
    await expect(upCommand([])).rejects.toThrow('exit:0')

    expect(engineMocks.stackStatus).toHaveBeenCalledWith({
      probes: [],
    })
    expect(existsSync(join(xdg, 'caracal', 'caracal.toml'))).toBe(false)
    expect(stdout).toContain('runtime services ready')
    expect(stdout).not.toContain('runtime onboarding complete')
    expect(stdout).not.toContain('runtime config not found')
  })

  it('forwards BuildKit env to compose when starting the stack', async () => {
    await expect(upCommand(['api'])).rejects.toThrow('exit:0')

    expect(engineMocks.stackUp).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          DOCKER_BUILDKIT: '1',
          COMPOSE_DOCKER_CLI_BUILD: '1',
        }),
      }),
    )
  })

  it('forwards BuildKit env to compose when stopping the stack', async () => {
    await expect(downCommand([])).rejects.toThrow('exit:0')

    expect(engineMocks.stackDown).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          DOCKER_BUILDKIT: '1',
          COMPOSE_DOCKER_CLI_BUILD: '1',
        }),
      }),
    )
  })

  it('upgrade stages images, migrates expand-first, rolls, then gates readiness', async () => {
    await expect(upgradeCommand([])).rejects.toThrow('exit:0')

    const calls = engineMocks.composeRun.mock.calls.map((c) => (c[0] as { args: string[] }).args)
    expect(calls).toContainEqual(['build'])
    const migrateIndex = calls.findIndex((a) => a[0] === 'run' && a.includes('dbMigrate'))
    expect(migrateIndex).toBeGreaterThanOrEqual(0)
    expect(engineMocks.stackUp).toHaveBeenCalledTimes(1)
    expect(engineMocks.stackStatus).toHaveBeenCalled()
    expect(stdout).toContain('runtime services ready')
  })

  it('upgrade pulls the pinned release in non-dev mode', async () => {
    engineMocks.resolveStackPaths.mockReturnValue({
      mode: 'stable',
      composeFile: '/tmp/caracal/docker-compose.yml',
      envFiles: [],
      cwd: '/tmp/caracal',
      secretsDir: '/tmp/caracal-secrets',
    })

    await expect(upgradeCommand([])).rejects.toThrow('exit:0')

    const calls = engineMocks.composeRun.mock.calls.map((c) => (c[0] as { args: string[] }).args)
    expect(calls).toContainEqual(['pull'])
    expect(calls).not.toContainEqual(['build'])
    expect(engineMocks.acquireStackLock).toHaveBeenCalledWith('/tmp/caracal')
    expect(engineMocks.appendUpgradeRecord).toHaveBeenCalledWith('/tmp/caracal', expect.objectContaining({ outcome: 'success' }))
  })

  it('upgrade skips the lock and journal in dev mode', async () => {
    await expect(upgradeCommand([])).rejects.toThrow('exit:0')

    expect(engineMocks.acquireStackLock).not.toHaveBeenCalled()
    expect(engineMocks.appendUpgradeRecord).not.toHaveBeenCalled()
  })

  it('upgrade aborts before rolling services when the migration fails', async () => {
    engineMocks.composeRun.mockImplementation((opts: { args: string[] }) => ({
      dispose: vi.fn(),
      exitCode: Promise.resolve(opts.args[0] === 'run' ? 1 : 0),
    }))

    await expect(upgradeCommand([])).rejects.toThrow('exit:1')

    expect(stderr).toContain('migration failed; the stack still runs the previous version')
    expect(engineMocks.stackUp).not.toHaveBeenCalled()
  })
})
