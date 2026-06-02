// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the shared dispatch entry point: flag validation, scope checks, hidden-command gating, and surface enumeration.

import { describe, it, expect } from 'vitest'
import {
  describeRemoteSurface,
  dispatch,
  DispatchError,
  validateFlags,
  type DispatchContext,
  type Principal,
} from '../../../../packages/engine/src/dispatch.js'
import type { AdminClient } from '../../../../packages/admin/ts/src/client.js'

const stubAdmin = {
  resources: { list: async (zoneId: string) => [zoneId] },
  zones: { list: async () => [] },
} as unknown as AdminClient
const ctx: DispatchContext = { admin: stubAdmin }

function principal(scopes: string[]): Principal {
  return { kind: 'remote', subject: 'sub', zoneId: 'z1', clientId: 'c1', scopes }
}

describe('validateFlags', () => {
  it('accepts a small flat flag map', () => {
    expect(() => validateFlags({ a: 'x', b: 1, c: true, d: null })).not.toThrow()
  })

  it('rejects unsupported nested values', () => {
    expect(() => validateFlags({ bad: { x: 1 } as unknown as string })).toThrow(DispatchError)
  })

  it('rejects oversize flag count', () => {
    const flags: Record<string, string> = {}
    for (let i = 0; i < 40; i++) flags['k' + i] = '1'
    expect(() => validateFlags(flags)).toThrow(/too many flags/)
  })
})

describe('dispatch', () => {
  it('denies unknown commands', async () => {
    await expect(
      dispatch({ command: 'nope', subcommand: '' }, principal([]), ctx),
    ).rejects.toMatchObject({ code: 'denied' })
  })

  it('blocks local-only Control management for remote principals', async () => {
    await expect(
      dispatch({ command: 'control', subcommand: 'key' }, principal(['control:control:read']), ctx),
    ).rejects.toMatchObject({ code: 'denied' })
  })

  it('denies missing scope', async () => {
    await expect(
      dispatch({ command: 'resource', subcommand: 'list' }, principal([]), ctx),
    ).rejects.toMatchObject({ code: 'denied' })
  })

  it('blocks global zone administration for remote principals', async () => {
    await expect(
      dispatch({ command: 'zone', subcommand: 'list' }, principal(['control:zone:read']), ctx),
    ).rejects.toMatchObject({ code: 'denied' })
  })

  it('accepts a matching per-resource scope', async () => {
    const result = await dispatch(
      { command: 'resource', subcommand: 'list' },
      principal(['control:resource:read']),
      ctx,
    )
    expect(result).toEqual(['z1'])
  })

  it('skips scope checks for local principals', async () => {
    const result = await dispatch(
      { command: 'zone', subcommand: 'list' },
      { kind: 'local', subject: 'console', scopes: [] },
      ctx,
    )
    expect(result).toEqual([])
  })

  it('blocks hidden diagnostics commands for remote principals', async () => {
    await expect(
      dispatch(
        { command: 'debug', subcommand: 'request', flags: { 'request-id': 'req-1' } },
        principal(['control:debug:read']),
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'denied' })
  })

  it('routes explain request with read scope', async () => {
    const admin = {
      audit: { explain: async (zoneId: string, requestId: string) => ({ zoneId, requestId }) },
    } as unknown as AdminClient
    const result = await dispatch(
      { command: 'explain', subcommand: '', flags: { 'request-id': 'req-1' } },
      principal(['control:explain:read']),
      { admin },
    )
    expect(result).toEqual({ zoneId: 'z1', requestId: 'req-1' })
  })
})

describe('describeRemoteSurface', () => {
  it('omits hidden and local-only commands', () => {
    const surface = describeRemoteSurface()
    for (const row of surface) {
      expect(row.command).not.toBe('zone')
      expect(row.command).not.toBe('control')
      expect(row.command).not.toBe('completion')
      expect(row.command).not.toBe('run')
      expect(row.command).not.toBe('credential')
    }
  })

  it('emits per-resource scope names', () => {
    const surface = describeRemoteSurface()
    const resourceList = surface.find((r) => r.command === 'resource' && r.subcommand === 'list')
    expect(resourceList?.scope).toBe('control:resource:read')
    const resourceCreate = surface.find((r) => r.command === 'resource' && r.subcommand === 'create')
    expect(resourceCreate?.scope).toBe('control:resource:write')
    const resourceDelete = surface.find((r) => r.command === 'resource' && r.subcommand === 'delete')
    expect(resourceDelete?.scope).toBe('control:resource:delete')
    const explainRequest = surface.find((r) => r.command === 'explain' && r.subcommand === '')
    expect(explainRequest?.scope).toBe('control:explain:read')
    expect(surface.find((r) => r.command === 'debug')).toBeUndefined()
  })
})
