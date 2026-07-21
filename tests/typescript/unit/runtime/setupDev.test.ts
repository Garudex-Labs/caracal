// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Developer setup tests cover portable child process execution.

import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0 })))
const existsSyncMock = vi.hoisted(() => vi.fn(() => true))
const platform = process.platform
const environment = { ...process.env }

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }))
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))

describe('developer setup', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset()
    spawnSyncMock.mockReturnValue({ status: 0 })
    existsSyncMock.mockReset()
    existsSyncMock.mockReturnValue(true)
    vi.resetModules()
    process.env = { ...environment }
    delete process.env.PYTHON
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    process.env = { ...environment }
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

  it('uses the configured Python executable directly', async () => {
    process.env.PYTHON = 'C:\Program Files\Python\python.exe'
    existsSyncMock.mockReturnValue(false)

    await import('../../../../scripts/setupDev.mjs')

    expect(spawnSyncMock).not.toHaveBeenCalledWith('python3', ['--version'], expect.anything())
    expect(spawnSyncMock).toHaveBeenCalledWith(process.env.PYTHON, ['-m', 'venv', '.venv'], expect.not.objectContaining({ shell: true }))
  })

  it('falls back to Python when python3 is unavailable', async () => {
    existsSyncMock.mockReturnValue(false)
    spawnSyncMock.mockImplementation((command, args) => ({
      status: command === 'python3' && args[0] === '--version' ? 1 : 0,
    }))

    await import('../../../../scripts/setupDev.mjs')

    expect(spawnSyncMock).toHaveBeenCalledWith('python', ['-m', 'venv', '.venv'], expect.not.objectContaining({ shell: true }))
  })
})
