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

    process.env = {
      ...ORIG_ENV,
      CARACAL_MODE: 'dev',
      CARACAL_REPO_ROOT: repoRoot,
      CARACAL_DEV_SECRETS_DIR: join(repoRoot, '.caracal', 'dev-secrets'),
    }
    engineMocks.runtimePaths.mockImplementation((home?: string) => {
      const root = home ?? runtimeHome
      return {
        home: root,
        composeFile: join(root, 'compose.yml'),
        secretsDir: join(root, 'secrets'),
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
      secretsDir: join(runtimeHome, 'secrets'),
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
    expect(output).toContain('Docker Compose unavailable; skipping stack, volumes, logs, and examples.')
    expect(output).not.toContain('Stop & remove containers')
    expect(engineMocks.installRuntimeAssets).not.toHaveBeenCalled()
    expect(engineMocks.composeRun).not.toHaveBeenCalled()
    expect(stderr).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('removes example compose projects and example-built images', async () => {
    mkdirSync(join(repoRoot, 'examples', 'echoUpstream'), { recursive: true })
    mkdirSync(join(repoRoot, 'examples', 'lynxCapital', '_mock'), { recursive: true })
    writeFileSync(join(repoRoot, 'examples', 'echoUpstream', 'compose.yml'), 'services:\n  echo:\n    build:\n      context: .\n    image: caracal-echo-upstream:latest\n')
    writeFileSync(join(repoRoot, 'examples', 'lynxCapital', '_mock', 'docker-compose.yml'), 'services:\n  mock:\n    build:\n      context: ..\n    image: lynx-mock:latest\n')
    writeFileSync(join(repoRoot, 'examples', 'lynxCapital', 'compose.yaml'), 'services:\n  lynx:\n    build:\n      context: .\n    image: lynx-app:latest\n  db:\n    image: postgres:17-alpine\n')
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'docker' && args[0] === 'compose') return { status: 0 }
      if (cmd === 'docker' && args[0] === 'images') {
        return {
          status: 0,
          stdout: [
            'caracal-echo-upstream:latest',
            'lynx-app:latest',
            'lynx-mock:latest',
            'postgres:17-alpine',
          ].join('\n'),
        }
      }
      if (cmd === 'pnpm') return { status: 0, stdout: '' }
      return { status: 0, stdout: '' }
    })

    await purgeCommand(['examples', '--yes'])

    expect(engineMocks.composeRun).toHaveBeenCalledTimes(3)
    expect(engineMocks.composeRun).toHaveBeenCalledWith(expect.objectContaining({
      args: ['down', '-v', '--remove-orphans'],
      includeControlProfile: false,
      paths: expect.objectContaining({
        composeFile: join(repoRoot, 'examples', 'echoUpstream', 'compose.yml'),
        cwd: join(repoRoot, 'examples', 'echoUpstream'),
      }),
    }))
    expect(engineMocks.composeRun).toHaveBeenCalledWith(expect.objectContaining({
      paths: expect.objectContaining({
        composeFile: join(repoRoot, 'examples', 'lynxCapital', '_mock', 'docker-compose.yml'),
        cwd: join(repoRoot, 'examples', 'lynxCapital', '_mock'),
      }),
    }))
    expect(engineMocks.composeRun).toHaveBeenCalledWith(expect.objectContaining({
      paths: expect.objectContaining({
        composeFile: join(repoRoot, 'examples', 'lynxCapital', 'compose.yaml'),
        cwd: join(repoRoot, 'examples', 'lynxCapital'),
      }),
    }))
    expect(engineMocks.removeImages).toHaveBeenCalledWith([
      'caracal-echo-upstream:latest',
      'lynx-app:latest',
      'lynx-mock:latest',
    ])
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

  it('removes resolved dev secret directories including explicit and legacy locations', async () => {
    const explicitSecrets = mkdtempSync(join(tmpdir(), 'caracal-purge-secrets-'))
    const devSecrets = mkdtempSync(join(tmpdir(), 'caracal-purge-dev-secrets-'))
    const legacySecrets = join(repoRoot, 'infra', 'secrets', 'files')
    try {
      process.env.CARACAL_SECRETS_DIR = explicitSecrets
      process.env.CARACAL_DEV_SECRETS_DIR = devSecrets
      mkdirSync(legacySecrets, { recursive: true })
      writeFileSync(join(repoRoot, 'infra', 'docker', 'local.env'), 'LOG_LEVEL=debug\n')

      await purgeCommand(['secrets', '--yes'])

      const removed = engineMocks.removeFsPath.mock.calls.map((call) => call[0])
      expect(removed).toContain(join(repoRoot, 'infra', 'docker', 'local.env'))
      expect(removed).toContain(explicitSecrets)
      expect(removed).toContain(devSecrets)
      expect(removed).toContain(legacySecrets)
    } finally {
      rmSync(explicitSecrets, { recursive: true, force: true })
      rmSync(devSecrets, { recursive: true, force: true })
    }
  })
})
