// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CLI status command unit tests for service health reporting.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { statusCommand } from '../../../../apps/cli/src/commands/stack.js'

describe('statusCommand', () => {
  let stdout = ''

  beforeEach(() => {
    stdout = ''
    vi.stubEnv('CARACAL_MODE', 'stable')
    vi.stubEnv('CARACAL_HOME', mkdtempSync(join(tmpdir(), 'caracal-home-')))
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    })
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`)
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('exits zero when all service probes are healthy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

    await expect(statusCommand()).rejects.toThrow('exit:0')

    expect(stdout).toContain('api          ')
    expect(stdout).toContain(' 3000  ')
    expect(stdout).toContain('ok')
    expect(stdout).toContain('coordinator  ')
    expect(stdout).toContain(' 4000  ')
  })

  it('exits nonzero and marks down services when a probe fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error('connect refused'))
      .mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    await expect(statusCommand()).rejects.toThrow('exit:1')

    expect(stdout).toContain('api          ')
    expect(stdout).toContain('sts          ')
    expect(stdout).toContain('down')
    expect(stdout).toContain('unreachable')
  })

  it('probes readiness when requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    await expect(statusCommand(['--ready', '--json'])).rejects.toThrow('exit:0')

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://localhost:3000/ready',
      'http://localhost:8080/ready',
      'http://localhost:8081/ready',
      'http://localhost:9090/ready',
      'http://localhost:4000/ready',
    ])
    const body = JSON.parse(stdout)
    expect(body.mode).toBe('ready')
  })
})
