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

vi.mock('@caracalai/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@caracalai/engine')>()
  return { ...actual, ...engineMocks }
})

vi.mock('../../../../packages/engine/dist/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../packages/engine/dist/index.js')>()
  return { ...actual, ...engineMocks }
})

vi.mock('@caracalai/engine/cli', () => ({
  resolveCliConfigPath: vi.fn(() => undefined),
}))

vi.mock('../../../../packages/engine/dist/cliconfig.js', () => ({
  resolveCliConfigPath: vi.fn(() => undefined),
}))

import { purgeCommand } from '../../../../apps/cli/src/commands/purge.ts'

const ORIG_ENV = { ...process.env }

describe('purgeCommand', () => {
  let repoRoot: string
  let runtimeHome: string
  let stdout: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>
  let exit: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
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
})
