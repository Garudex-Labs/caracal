// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for purge command runtime asset cleanup coordination.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engineMocks = vi.hoisted(() => ({
  composeRun: vi.fn(),
  installRuntimeAssets: vi.fn(() => ({ created: false, filesCreated: [] })),
  listCaracalImages: vi.fn((): string[] => []),
  removeFsPath: vi.fn(() => ({ removed: true })),
  removeImages: vi.fn(() => Promise.resolve(0)),
  runtimePaths: vi.fn(),
  caracalBinaries: vi.fn((): string[] => []),
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

vi.mock('../../../../packages/engine/dist/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../packages/engine/dist/index.js')>()
  return { ...actual, ...engineMocks }
})

vi.mock('@caracalai/engine/runtime-config', () => ({
  resolveRuntimeConfigPath: vi.fn(() => undefined),
}))

vi.mock('../../../../packages/engine/dist/runtimeConfig.js', () => ({
  resolveRuntimeConfigPath: vi.fn(() => undefined),
}))

import { purgeCommand } from '../../../../apps/runtime/src/commands/purge.ts'

const ORIG_ENV = { ...process.env }

describe('purgeCommand', () => {
  let repoRoot: string
  let runtimeHome: string
  let stdout: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>
  let exit: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    repoRoot = mkdtempSync(join(tmpdir(), 'caracal-purge-repo-'))
    runtimeHome = mkdtempSync(join(tmpdir(), 'caracal-purge-runtime-'))
    mkdirSync(join(repoRoot, 'infra', 'docker'), { recursive: true })
    writeFileSync(join(repoRoot, 'infra', 'docker', 'docker-compose.yml'), 'name: caracal-dev\n')
    writeFileSync(join(repoRoot, 'infra', 'docker', 'dev.env'), 'CARACAL_MODE=dev\n')
    writeFileSync(join(runtimeHome, 'compose.yml'), 'services:\n  stsReplay:\n')
    writeFileSync(join(runtimeHome, 'caracal.env'), '# operator\n')

    process.env = { ...ORIG_ENV, CARACAL_MODE: 'dev', CARACAL_REPO_ROOT: repoRoot }
    engineMocks.runtimePaths.mockImplementation((home?: string) => {
      const root = home ?? runtimeHome
      return {
        home: root,
        composeFile: join(root, 'compose.yml'),
        overrideEnvFile: join(root, 'caracal.env'),
      }
    })
    engineMocks.composeRun.mockImplementation(() => ({ dispose: vi.fn(), exitCode: Promise.resolve(0) }))
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'docker' && args[0] === 'compose') return { status: 0 }
      if (cmd === 'pnpm') return { status: 0, stdout: '' }
      return { status: 0, stdout: '' }
    })
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of [repoRoot, runtimeHome]) {
      rmSync(dir, { recursive: true, force: true })
    }
    process.env = { ...ORIG_ENV }
  })

  it('refreshes selected runtime assets before compose cleanup', async () => {
    await purgeCommand(['all', '--yes'])

    expect(engineMocks.installRuntimeAssets).toHaveBeenCalledWith({
      home: runtimeHome,
      composeFile: join(runtimeHome, 'compose.yml'),
      overrideEnvFile: join(runtimeHome, 'caracal.env'),
    }, 'stable')
    expect(engineMocks.installRuntimeAssets.mock.invocationCallOrder[0]).toBeLessThan(
      engineMocks.composeRun.mock.invocationCallOrder[0],
    )
    expect(engineMocks.composeRun).toHaveBeenCalledWith(expect.objectContaining({
      paths: expect.objectContaining({
        composeFile: join(runtimeHome, 'compose.yml'),
        cwd: runtimeHome,
      }),
    }))
    expect(stdout.mock.calls.map((c) => c[0]).join('')).toContain('Purge complete.')
    expect(stderr).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('reports missing docker executable when compose cannot start', async () => {
    engineMocks.composeRun.mockImplementationOnce(() => ({ dispose: vi.fn(), exitCode: Promise.resolve(127) }))

    await expect(purgeCommand(['stack', '--yes'])).rejects.toThrow('exit:1')

    expect(stderr.mock.calls.map((c) => c[0]).join('')).toContain(
      'stack failed: docker executable not found on PATH while running compose down --remove-orphans for dev stack',
    )
  })

  it('skips compose targets from full purge when Docker Compose is unavailable', async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'docker' && args[0] === 'compose') return { status: 127 }
      if (cmd === 'pnpm') return { status: 0, stdout: '' }
      return { status: 0, stdout: '' }
    })

    await purgeCommand(['all', '--yes'])

    const output = stdout.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('Docker Compose unavailable; skipping stack, volumes, and logs.')
    expect(output).not.toContain('Stop & remove containers')
    expect(engineMocks.installRuntimeAssets).not.toHaveBeenCalled()
    expect(engineMocks.composeRun).not.toHaveBeenCalled()
    expect(stderr).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('fails explicit compose targets when Docker Compose is unavailable', async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'docker' && args[0] === 'compose') return { status: 127 }
      if (cmd === 'pnpm') return { status: 0, stdout: '' }
      return { status: 0, stdout: '' }
    })

    await expect(purgeCommand(['stack', '--yes'])).rejects.toThrow('exit:1')

    expect(stderr.mock.calls.map((c) => c[0]).join('')).toContain(
      'stack unavailable: docker compose is not available; install Docker with the Compose plugin or add docker to PATH',
    )
    expect(engineMocks.composeRun).not.toHaveBeenCalled()
  })
})
