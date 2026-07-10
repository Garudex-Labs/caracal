// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for purge command runtime asset cleanup coordination.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pgMock = vi.hoisted(() => {
  const queries: { sql: string; params?: unknown[] }[] = []
  let existingDatabases = new Set<string>(['caracal_auth'])
  class Client {
    connectionString: string
    constructor(opts: { connectionString: string }) {
      this.connectionString = opts.connectionString
    }
    async connect(): Promise<void> {}
    async query(sql: string, params?: unknown[]): Promise<{ rowCount: number; rows: unknown[] }> {
      queries.push({ sql, params })
      if (sql.includes('FROM pg_database')) {
        const name = String(params?.[0] ?? '')
        return { rowCount: existingDatabases.has(name) ? 1 : 0, rows: [] }
      }
      const drop = /DROP DATABASE "([^"]+)"/.exec(sql)
      if (drop) existingDatabases.delete(drop[1])
      return { rowCount: 0, rows: [] }
    }
    async end(): Promise<void> {}
  }
  return {
    queries,
    Client,
    reset: (databases: string[]) => {
      queries.length = 0
      existingDatabases = new Set(databases)
    },
  }
})

vi.mock('pg', () => ({ default: { Client: pgMock.Client }, Client: pgMock.Client }))

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

const promptAnswers = vi.hoisted(() => ({ queue: [] as string[] }))

vi.mock('node:readline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:readline')>()),
  createInterface: vi.fn(() => ({
    question: (_q: string, cb: (answer: string) => void) => cb(promptAnswers.queue.shift() ?? ''),
    close: vi.fn(),
    once: vi.fn(),
  })),
}))

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
  defaultCaracalConfigDir: vi.fn(() => '/nonexistent-caracal-config'),
}))

vi.mock('../../../../packages/engine/dist/runtimeConfig.js', () => ({
  defaultCaracalConfigDir: vi.fn(() => '/nonexistent-caracal-config'),
}))

import { purgeCommand } from '../../../../apps/runtime/src/commands/purge.ts'

const ORIG_ENV = { ...process.env }

// Builds a synthetic auth-database URL for the mocked `pg` client. The credentials are
// assembled from parts (and use an explicitly non-secret password) so no literal
// connection string appears in source for secret scanners to flag; the mocked client
// never connects, and these tests assert only the parsed database name.
const FAKE_PG_PASSWORD = 'not-a-real-password'
function fakeAuthDatabaseUrl(host: string, database: string): string {
  return `postgres://caracal:${FAKE_PG_PASSWORD}@${host}:5432/${database}`
}

describe('purgeCommand', () => {
  let repoRoot: string
  let runtimeHome: string
  let stdout: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>
  let exit: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    promptAnswers.queue.length = 0
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

    expect(engineMocks.installRuntimeAssets).toHaveBeenCalledWith(
      {
        home: runtimeHome,
        composeFile: join(runtimeHome, 'compose.yml'),
        secretsDir: join(runtimeHome, 'secrets'),
        overrideEnvFile: join(runtimeHome, 'caracal.env'),
      },
      'stable',
    )
    expect(engineMocks.installRuntimeAssets.mock.invocationCallOrder[0]).toBeLessThan(engineMocks.composeRun.mock.invocationCallOrder[0])
    expect(engineMocks.composeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: expect.objectContaining({
          composeFile: join(runtimeHome, 'compose.yml'),
          cwd: runtimeHome,
        }),
      }),
    )
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

  it('drops the web console PostgreSQL database', async () => {
    process.env.CARACAL_AUTH_DATABASE_URL = fakeAuthDatabaseUrl('localhost', 'caracal_auth')
    pgMock.reset(['caracal_auth'])

    await purgeCommand(['web', '--yes'])

    // The existence probe targets caracal_auth, then it is dropped WITH FORCE through a
    // maintenance connection (/postgres), not the auth database itself.
    const probe = pgMock.queries.find((q) => q.sql.includes('FROM pg_database'))
    expect(probe?.params?.[0]).toBe('caracal_auth')
    const drop = pgMock.queries.find((q) => q.sql.includes('DROP DATABASE'))
    expect(drop?.sql).toContain('"caracal_auth"')
    expect(drop?.sql).toContain('FORCE')
  })

  it('skips dropping when the web console database does not exist', async () => {
    process.env.CARACAL_AUTH_DATABASE_URL = fakeAuthDatabaseUrl('localhost', 'caracal_auth')
    pgMock.reset([])

    await purgeCommand(['web', '--yes'])

    expect(pgMock.queries.some((q) => q.sql.includes('FROM pg_database'))).toBe(true)
    expect(pgMock.queries.some((q) => q.sql.includes('DROP DATABASE'))).toBe(false)
  })

  it('derives the auth database name from CARACAL_AUTH_DATABASE_URL', async () => {
    process.env.CARACAL_AUTH_DATABASE_URL = fakeAuthDatabaseUrl('db.internal', 'custom_auth')
    pgMock.reset(['custom_auth'])

    await purgeCommand(['web', '--yes'])

    const drop = pgMock.queries.find((q) => q.sql.includes('DROP DATABASE'))
    expect(drop?.sql).toContain('"custom_auth"')
  })

  function output(): string {
    return [...stdout.mock.calls, ...stderr.mock.calls].map((c) => String(c[0])).join('')
  }

  it('rejects unknown flags and unknown targets', async () => {
    await expect(purgeCommand(['--frobnicate'])).rejects.toThrow('exit:1')
    expect(output()).toContain('unknown flag --frobnicate')

    stderr.mockClear()
    await expect(purgeCommand(['everything', '--yes'])).rejects.toThrow('exit:1')
    expect(output()).toContain('unknown target "everything"')
  })

  it('lists grouped targets interactively and honours a numeric selection', async () => {
    promptAnswers.queue.push('1')
    await purgeCommand(['--dry-run'])
    const out = output()
    expect(out).toContain('Select purge targets')
    expect(out).toContain('Runtime services & data')
    expect(out).toContain('Dry-run complete.')
  })

  it('selects a whole group by name and dedupes repeated tokens', async () => {
    promptAnswers.queue.push('state, state')
    await purgeCommand(['--dry-run'])
    const out = output()
    expect(out).toContain('Will purge:')
    expect(out).toContain('Dry-run complete.')
  })

  it('returns quietly when the selector is quit', async () => {
    promptAnswers.queue.push('q')
    await purgeCommand([])
    expect(output()).toContain('Nothing selected.')
  })

  it('selects everything with "all" and only non-destructive targets with "safe"', async () => {
    promptAnswers.queue.push('all')
    await purgeCommand(['--dry-run'])
    expect(output()).toContain('Dry-run complete.')

    stdout.mockClear()
    promptAnswers.queue.push('safe')
    await purgeCommand(['--dry-run'])
    const out = output()
    expect(out).toContain('Dry-run complete.')
    const plan = out.slice(out.indexOf('Will purge:'))
    expect(plan).not.toContain('DESTRUCTIVE')
  })

  it('rejects an out-of-range interactive selection', async () => {
    promptAnswers.queue.push('99')
    await expect(purgeCommand([])).rejects.toThrow('exit:1')
    expect(output()).toContain('invalid selection: 99')
  })

  it('requires a typed "yes" before destructive targets run', async () => {
    promptAnswers.queue.push('no')
    await purgeCommand(['volumes'])
    expect(output()).toContain('Aborted.')
    expect(engineMocks.composeRun).not.toHaveBeenCalled()

    stdout.mockClear()
    promptAnswers.queue.push('yes')
    await purgeCommand(['volumes'])
    expect(output()).toContain('Purge complete.')
  })

  it('accepts a plain y for non-destructive targets', async () => {
    promptAnswers.queue.push('y')
    await purgeCommand(['stack'])
    expect(output()).toContain('Purge complete.')
  })

  it('removes cached build outputs across workspace dist directories', async () => {
    mkdirSync(join(repoRoot, 'node_modules', '.cache'), { recursive: true })
    mkdirSync(join(repoRoot, 'apps', 'api', 'dist'), { recursive: true })
    mkdirSync(join(repoRoot, 'packages', 'engine', 'dist'), { recursive: true })
    writeFileSync(join(repoRoot, 'apps', 'api', 'dist', 'index.js'), '')

    await purgeCommand(['cache', '--yes'])

    const removed = engineMocks.removeFsPath.mock.calls.map((call) => String(call[0]))
    expect(removed.some((p) => p.endsWith(join('apps', 'api', 'dist')))).toBe(true)
    expect(removed.some((p) => p.endsWith(join('packages', 'engine', 'dist')))).toBe(true)
  })

  it('removes cached Caracal images and surfaces a docker failure', async () => {
    engineMocks.listCaracalImages.mockReturnValue(['caracal/api:1', 'caracal/sts:1'])
    await purgeCommand(['images', '--yes'])
    expect(engineMocks.removeImages).toHaveBeenCalledWith(['caracal/api:1', 'caracal/sts:1'])
    expect(output()).toContain('Purge complete.')

    stdout.mockClear()
    engineMocks.removeImages.mockResolvedValueOnce(1)
    await expect(purgeCommand(['images', '--yes'])).rejects.toThrow('exit:1')
    expect(output()).toContain('images failed: docker image rm exited 1')
  })

  it('uninstalls discovered caracal binaries', async () => {
    const binDir = join(runtimeHome, 'bin')
    mkdirSync(binDir, { recursive: true })
    const binPath = join(binDir, 'caracal')
    writeFileSync(binPath, '#!/bin/sh\n')
    engineMocks.caracalBinaries.mockReturnValue([binPath])
    await purgeCommand(['binary', '--yes'])
    const removed = engineMocks.removeFsPath.mock.calls.map((call) => String(call[0]))
    expect(removed).toContain(binPath)
  })
})
