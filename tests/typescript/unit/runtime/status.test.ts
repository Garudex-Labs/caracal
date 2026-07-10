// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime status command unit tests for service health reporting.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { statusCommand } from '../../../../apps/runtime/src/commands/stack.js'

describe('statusCommand', () => {
  let stdout = ''

  beforeEach(() => {
    stdout = ''
    process.exitCode = undefined
    vi.stubEnv('CARACAL_MODE', 'stable')
    vi.stubEnv('CARACAL_HOME', mkdtempSync(join(tmpdir(), 'caracal-home-')))
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    })
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  })

  afterEach(() => {
    process.exitCode = undefined
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('exits zero when all service probes are healthy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

    await statusCommand()

    expect(process.exitCode).toBe(0)
    expect(process.exit).not.toHaveBeenCalled()
    expect(stdout).toContain('api          ')
    expect(stdout).toContain(' 3000  ')
    expect(stdout).toContain('ok')
    expect(stdout).toContain('coordinator  ')
    expect(stdout).toContain(' 4000  ')
  })

  it('exits nonzero and marks down services when a probe fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error('connect refused'))
      .mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    await statusCommand()

    expect(process.exitCode).toBe(1)
    expect(process.exit).not.toHaveBeenCalled()
    expect(stdout).toContain('api          ')
    expect(stdout).toContain('sts          ')
    expect(stdout).toContain('down')
    expect(stdout).toContain('unreachable')
  })

  it('probes readiness when requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    await statusCommand(['--ready', '--json'])

    expect(process.exitCode).toBe(0)
    expect(process.exit).not.toHaveBeenCalled()
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

  it('includes readiness failure reasons in machine output', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ ok: false, reason: 'stream_consumers_not_ready' }),
      })
      .mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    await statusCommand(['--ready', '--json'])

    expect(process.exitCode).toBe(1)
    expect(process.exit).not.toHaveBeenCalled()
    const body = JSON.parse(stdout)
    expect(body.services[1]).toMatchObject({
      name: 'sts',
      ok: false,
      detail: '503 stream_consumers_not_ready',
    })
  })
})
