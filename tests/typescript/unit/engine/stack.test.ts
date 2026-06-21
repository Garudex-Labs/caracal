// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Engine stack helper tests cover probes, filesystem cleanup, image filtering, and purge ordering.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  caracalBinaries,
  defaultServiceProbes,
  listCaracalImages,
  removeFsPath,
  stackPurge,
  stackStatus,
} from '../../../../packages/engine/src/stack.js'

const spawnSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}))

describe('stack probes', () => {
  const saved = { ...process.env }
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-stack-'))
  })

  afterEach(() => {
    process.env = { ...saved }
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('targets every deployable on its ready endpoint without a separate control probe', () => {
    const probes = defaultServiceProbes('ready')

    expect(probes.every((p) => p.url.endsWith('/ready'))).toBe(true)
    expect(probes.some((p) => p.name === 'control')).toBe(false)
    expect(probes.map((p) => p.name)).toEqual(expect.arrayContaining(['api', 'sts', 'gateway', 'audit', 'coordinator']))
  })

  it('returns status details for ok, JSON error, text error, and fetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/ok')) return new Response(null, { status: 204 })
      if (url.endsWith('/json')) return new Response(JSON.stringify({ error: 'booting' }), { status: 503 })
      if (url.endsWith('/text')) return new Response('not ready\nmore', { status: 503 })
      throw new Error('connection refused')
    }))

    await expect(stackStatus({
      timeoutMs: 50,
      probes: [
        { name: 'ok', url: 'http://svc/ok', port: 1 },
        { name: 'json', url: 'http://svc/json', port: 2 },
        { name: 'text', url: 'http://svc/text', port: 3 },
        { name: 'fail', url: 'http://svc/fail', port: 4 },
      ],
    })).resolves.toEqual([
      expect.objectContaining({ name: 'ok', ok: true, detail: '204' }),
      expect.objectContaining({ name: 'json', ok: false, detail: '503 booting' }),
      expect.objectContaining({ name: 'text', ok: false, detail: '503 not ready' }),
      expect.objectContaining({ name: 'fail', ok: false, detail: 'unreachable' }),
    ])
  })
})

describe('stack cleanup helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('filters Docker image output to Caracal repositories', () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: [
        'caracal/api:dev',
        'localhost/caracal-sts:dev',
        'ghcr.io/garudex-labs/caracal-gateway:stable',
        'postgres:16',
        '',
      ].join('\n'),
    })

    expect(listCaracalImages()).toEqual([
      'caracal/api:dev',
      'localhost/caracal-sts:dev',
      'ghcr.io/garudex-labs/caracal-gateway:stable',
    ])
  })

  it('returns an empty image list when Docker fails', () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '' })

    expect(listCaracalImages()).toEqual([])
  })

  it('removes files and directories only when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-remove-'))
    const file = join(dir, 'file')
    const nested = join(dir, 'nested')
    writeFileSync(file, 'x')
    mkdirSync(nested)

    expect(removeFsPath(join(dir, 'missing'))).toEqual({ removed: false })
    expect(removeFsPath(file)).toEqual({ removed: true })
    expect(removeFsPath(nested)).toEqual({ removed: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds Caracal binaries across install and extra directories and preserves purge ordering', async () => {
    const install = mkdtempSync(join(tmpdir(), 'caracal-bin-install-'))
    const extra = mkdtempSync(join(tmpdir(), 'caracal-bin-extra-'))
    writeFileSync(join(install, 'caracal'), '')
    writeFileSync(join(extra, 'caracal-console'), '')
    const events: string[] = []

    expect(caracalBinaries(install, [extra])).toEqual([
      join(install, 'caracal'),
      join(extra, 'caracal-console'),
      join(extra, 'caracal-console'),
    ])

    await stackPurge({
      steps: [
        { id: 'one', label: 'One', run: async () => { events.push('run:one') } },
        { id: 'two', label: 'Two', run: async () => { events.push('run:two') } },
      ],
      onStep: (step, phase) => events.push(`${phase}:${step.id}`),
    })

    expect(events).toEqual(['start:one', 'run:one', 'end:one', 'start:two', 'run:two', 'end:two'])
    rmSync(install, { recursive: true, force: true })
    rmSync(extra, { recursive: true, force: true })
  })
})
