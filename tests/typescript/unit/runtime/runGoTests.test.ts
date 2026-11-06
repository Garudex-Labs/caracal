// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Go runner must not report cached live-database tests as a fresh validation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn((_command: string, _args: string[]) => ({ status: 0, stdout: '1\n' })))
vi.mock('node:child_process', () => ({ spawnSync: spawn }))
vi.mock('node:fs', () => ({
  existsSync: () => true,
  readdirSync: () => [],
  readFileSync: () => '',
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}))
const argv = [...process.argv]

beforeEach(() => {
  spawn.mockClear()
  vi.resetModules()
  process.argv = [argv[0], 'runGoTests.mjs']
})
afterEach(() => {
  process.argv = argv
  vi.unstubAllEnvs()
})

describe('live Go test execution', () => {
  it.each([false, true])('disables result caching only for live PostgreSQL runs (live=%s)', async (live) => {
    vi.stubEnv('CARACAL_TEST_DATABASE_URL', live ? 'postgres://test' : undefined)
    await import('../../../../scripts/runGoTests.mjs')
    const runs = spawn.mock.calls.filter((call) => call[0] === 'go' && call[1][0] === 'test')
    expect(runs).toHaveLength(2)
    for (const call of runs) {
      expect(call[1].includes('-count=1')).toBe(live)
      expect(call[1]).toContain('-race')
    }
  })
})
