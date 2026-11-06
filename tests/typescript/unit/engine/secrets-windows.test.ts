// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Platform-boundary regressions; these simulate Windows, not native Windows runtime tests.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawnSync }))
const platform = process.platform
const directories: string[] = []

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.resetModules()
})

describe('Windows secret initialization', () => {
  it.each([{ status: 1 }, { status: null, error: new Error('ENOENT') }])(
    'does not write secrets when ACL setup fails (%o)',
    async (failure) => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      vi.resetModules()
      spawnSync.mockReturnValue(failure)
      const { bootstrapSecrets } = await import('../../../../packages/engine/src/secrets.ts')
      const dir = mkdtempSync(join(tmpdir(), 'caracal secret ACL '))
      directories.push(dir)
      expect(() => bootstrapSecrets({ secretsDir: dir })).toThrow(/secure.*Windows.*icacls/)
      expect(readdirSync(dir)).toEqual([])
      expect(spawnSync).toHaveBeenCalledWith(
        'icacls',
        expect.arrayContaining([dir, '/inheritance:r']),
        expect.objectContaining({ windowsHide: true }),
      )
    },
  )
})
