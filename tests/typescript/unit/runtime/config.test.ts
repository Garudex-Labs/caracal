// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the caracal config operator env file command.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configCommand } from '../../../../apps/runtime/src/commands/config.ts'

describe('configCommand', () => {
  let dir: string
  let target: string
  let stdout: string
  let stderr: string
  let saved: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-config-'))
    target = join(dir, 'caracal.env')
    saved = process.env.CARACAL_ENV_FILE
    process.env.CARACAL_ENV_FILE = target
    stdout = ''
    stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString()
      return true
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (saved === undefined) delete process.env.CARACAL_ENV_FILE
    else process.env.CARACAL_ENV_FILE = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('prints the target path', async () => {
    await configCommand(['path'])
    expect(stdout.trim()).toBe(target)
  })

  it('sets a variable, creating the file, and gets it back', async () => {
    await configCommand(['set', 'CARACAL_WORKLOAD_ID=fiona'])
    expect(existsSync(target)).toBe(true)
    stdout = ''
    await configCommand(['get', 'CARACAL_WORKLOAD_ID'])
    expect(stdout.trim()).toBe('fiona')
  })

  it('accepts the KEY VALUE form and updates in place', async () => {
    await configCommand(['set', 'CARACAL_STS_URL', 'http://localhost:8080'])
    await configCommand(['set', 'CARACAL_STS_URL', 'https://sts.pipernet.example'])
    const text = readFileSync(target, 'utf8')
    expect(text.match(/CARACAL_STS_URL=/g)).toHaveLength(1)
    expect(text).toContain('CARACAL_STS_URL=https://sts.pipernet.example')
  })

  it('masks secret values in list', async () => {
    await configCommand(['set', 'CARACAL_WORKLOAD_ID=fiona'])
    await configCommand(['set', 'CARACAL_WORKLOAD_SECRET', 'do-not-print'])
    stdout = ''
    await configCommand(['list'])
    expect(stdout).toContain('CARACAL_WORKLOAD_ID=fiona')
    expect(stdout).toContain('CARACAL_WORKLOAD_SECRET=***')
    expect(stdout).not.toContain('do-not-print')
  })

  it('unsets a variable', async () => {
    await configCommand(['set', 'CARACAL_WORKLOAD_ID=fiona'])
    await configCommand(['unset', 'CARACAL_WORKLOAD_ID'])
    await expect(configCommand(['get', 'CARACAL_WORKLOAD_ID'])).rejects.toThrow('exit:1')
  })

  it('rejects an invalid variable name', async () => {
    await expect(configCommand(['set', 'bad-key=1'])).rejects.toThrow('exit:1')
    expect(stderr).toContain("invalid variable name 'bad-key'")
  })
})
