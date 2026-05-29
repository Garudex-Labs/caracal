// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the sibling-binary executor used to dispatch `caracal console` to its installed binary.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { availableInterfaceCommands, execSibling } from '../../../../apps/runtime/src/commands/dispatch.ts'

const originalEnv = { ...process.env }

afterEach(() => {
  vi.restoreAllMocks()
  process.env = { ...originalEnv }
})

describe('execSibling', () => {
  it('exits 127 with a hint when a known sibling binary is not installed', () => {
    const origPath = process.env.PATH
    const origRoot = process.env.CARACAL_REPO_ROOT
    process.env.PATH = '/nonexistent-caracal-dir'
    delete process.env.CARACAL_REPO_ROOT
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as never)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      expect(() => execSibling('caracal-console', [], { installLine: 'install hint' })).toThrow('exit:127')
      expect(exit).toHaveBeenCalledWith(127)
      const errOut = [...stderr.mock.calls, ...stdout.mock.calls].map((c) => String(c[0])).join('')
      expect(errOut).toContain('install hint')
    } finally {
      process.env.PATH = origPath
      if (origRoot !== undefined) process.env.CARACAL_REPO_ROOT = origRoot
    }
  })

  it('refuses to dispatch to a non-whitelisted binary name', () => {
    expect(() => execSibling('../../evil', [], { installLine: 'x' })).toThrow(/non-whitelisted/)
    expect(() => execSibling('caracal-nonexistent', [], { installLine: 'x' })).toThrow(/non-whitelisted/)
  })

  it('reports only interface commands with an available workspace shim', () => {
    const root = mkdtempSync(join(tmpdir(), 'caracal-root-'))
    const consoleBin = join(root, 'apps', 'console', 'bin')
    mkdirSync(consoleBin, { recursive: true })
    process.env.CARACAL_REPO_ROOT = root

    expect(availableInterfaceCommands()).toEqual([])

    writeFileSync(join(consoleBin, 'caracal-console-workspace.mjs'), '')
    expect(availableInterfaceCommands()).toEqual(['console'])
  })
})
