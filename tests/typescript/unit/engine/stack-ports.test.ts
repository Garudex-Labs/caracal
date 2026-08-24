// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for Compose-derived stack port conflict detection.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StackPaths } from '../../../../packages/engine/src/stack.ts'

const spawnSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}))

import { stackPortPreflight, type StackPortBinding } from '../../../../packages/engine/src/stackPorts.ts'

let dir: string
let paths: StackPaths

function config(services: Record<string, unknown>): string {
  return JSON.stringify({ name: 'caracal-dev', services })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caracal-stack-ports-'))
  const composeFile = join(dir, 'compose.yml')
  writeFileSync(composeFile, 'services: {}\n')
  paths = { composeFile, envFiles: [], cwd: dir, mode: 'dev', secretsDir: join(dir, 'secrets') }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  spawnSyncMock.mockReset()
})

describe('stack port preflight', () => {
  it('reports every unavailable TCP binding derived from Compose', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: config({
          redis: { ports: [{ host_ip: '127.0.0.1', published: '6379', protocol: 'tcp' }] },
          web: { ports: [{ host_ip: '127.0.0.1', published: '3001', protocol: 'tcp' }] },
        }),
      })
      .mockReturnValueOnce({ status: 0, stdout: '[]' })

    const result = await stackPortPreflight({
      paths,
      args: [],
      isPortAvailable: async () => false,
    })

    expect(result).toEqual({
      conflicts: [
        { service: 'redis', host: '127.0.0.1', port: 6379, protocol: 'tcp' },
        { service: 'web', host: '127.0.0.1', port: 3001, protocol: 'tcp' },
      ],
      projectExisted: false,
    })
  })

  it('allows ports already published by the target Compose project', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: config({ api: { ports: [{ host_ip: '127.0.0.1', published: '3000', protocol: 'tcp' }] } }),
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([{ State: 'running', Publishers: [{ URL: '127.0.0.1', PublishedPort: 3000, Protocol: 'tcp' }] }]),
      })
    const check = vi.fn(async () => false)

    await expect(stackPortPreflight({ paths, args: [], isPortAvailable: check })).resolves.toEqual({
      conflicts: [],
      projectExisted: true,
    })
    expect(check).not.toHaveBeenCalled()
  })

  it('checks only selected services and their dependencies', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: config({
          api: { depends_on: { redis: { condition: 'service_healthy' } }, ports: [{ published: '3000' }] },
          redis: { ports: [{ published: '6379' }] },
          web: { ports: [{ published: '3001' }] },
        }),
      })
      .mockReturnValueOnce({ status: 0, stdout: '' })
    const checked: StackPortBinding[] = []

    const result = await stackPortPreflight({
      paths,
      args: ['api'],
      isPortAvailable: async (binding) => {
        checked.push(binding)
        return true
      },
    })

    expect(result.conflicts).toEqual([])
    expect(checked.map((binding) => binding.service)).toEqual(['api', 'redis'])
  })

  it('fails closed when Compose cannot resolve the configuration', async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'invalid compose' })

    await expect(stackPortPreflight({ paths, args: [] })).rejects.toThrow(
      'could not inspect Docker Compose port bindings (config --format json)',
    )
  })

  it('does not treat stopped project containers as owners of occupied ports', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: config({ api: { ports: [{ host_ip: '127.0.0.1', published: '3000', protocol: 'tcp' }] } }),
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([{ State: 'exited', Publishers: [{ URL: '127.0.0.1', PublishedPort: 3000, Protocol: 'tcp' }] }]),
      })

    await expect(stackPortPreflight({ paths, args: [], isPortAvailable: async () => false })).resolves.toEqual({
      conflicts: [{ service: 'api', host: '127.0.0.1', port: 3000, protocol: 'tcp' }],
      projectExisted: true,
    })
  })
})
