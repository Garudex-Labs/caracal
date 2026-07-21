// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Developer setup tests cover portable child process execution.

import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0 })))
const existsSyncMock = vi.hoisted(() => vi.fn(() => true))
const platform = process.platform

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }))
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))

describe('developer setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    vi.restoreAllMocks()
  })

  it('runs Windows executable paths directly and shells only pnpm', async () => {
    await import('../../../../scripts/setupDev.mjs')

    const root = resolve(import.meta.dirname, '../../../..')
    const venvPython = join(root, '.venv', 'Scripts/python.exe')
    const venvCalls = spawnSyncMock.mock.calls.filter(([command]) => command === venvPython)

    expect(venvCalls).toHaveLength(3)
    for (const call of venvCalls) expect(call[2]).not.toHaveProperty('shell')
    expect(spawnSyncMock).toHaveBeenCalledWith('pnpm', ['install', '--frozen-lockfile'], expect.objectContaining({ shell: true }))
    for (const command of ['git', 'go']) {
      const call = spawnSyncMock.mock.calls.find(([spawned]) => spawned === command)
      expect(call?.[2]).not.toHaveProperty('shell')
    }
  })
})
