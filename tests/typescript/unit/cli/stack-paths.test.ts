// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for stack mode path resolution.

import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePaths } from '../../../../apps/cli/src/commands/stack.ts'

function repoFixture(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'caracal-repo-'))
  const dockerDir = join(repoRoot, 'infra', 'docker')
  mkdirSync(dockerDir, { recursive: true })
  writeFileSync(join(dockerDir, 'docker-compose.yml'), 'name: caracal\n')
  writeFileSync(join(dockerDir, '.env.example'), '')
  writeFileSync(join(dockerDir, '.env'), 'POSTGRES_PASSWORD=test\n')
  return repoRoot
}

describe('resolvePaths', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses dev mode when CARACAL_MODE=dev and CARACAL_REPO_ROOT is set', () => {
    const repoRoot = repoFixture()
    vi.stubEnv('CARACAL_MODE', 'dev')
    vi.stubEnv('CARACAL_REPO_ROOT', repoRoot)
    vi.stubEnv('CARACAL_ENV_FILE', join(repoRoot, 'infra', 'docker', '.env'))

    const paths = resolvePaths()

    expect(paths.mode).toBe('dev')
    expect(paths.cwd).toBe(repoRoot)
    expect(paths.composeFile).toBe(join(repoRoot, 'infra', 'docker', 'docker-compose.yml'))
  })

  it('uses stable mode when CARACAL_MODE=stable', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-home-'))
    vi.stubEnv('CARACAL_MODE', 'stable')
    vi.stubEnv('CARACAL_HOME', home)

    const paths = resolvePaths()

    expect(paths.mode).toBe('stable')
    expect(paths.cwd).toBe(home)
    expect(paths.composeFile).toBe(join(home, 'compose.yml'))
  })
})
