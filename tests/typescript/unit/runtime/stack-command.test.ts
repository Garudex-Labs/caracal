// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for runtime stack command Docker Compose preflight handling.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engineMocks = vi.hoisted(() => ({
  defaultServiceProbes: vi.fn(() => []),
  resolveStackPaths: vi.fn(),
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

import { downCommand, upCommand } from '../../../../apps/runtime/src/commands/stack.ts'

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

    expect(stderr).toContain('docker daemon is not reachable; start Docker and ensure your user can access /var/run/docker.sock')
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
})
