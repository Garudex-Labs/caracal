// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Engine dispatcher tests cover bounded flags and command handler edge cases.

import { describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../../../../packages/admin/ts/src/client.js'
import { dispatch, DispatchError, validateFlags, type Principal } from '../../../../packages/engine/src/dispatch.js'

const local: Principal = {
  kind: 'local',
  subject: 'operator',
  zoneId: 'z1',
  scopes: [],
}

const remote: Principal = {
  kind: 'remote',
  subject: 'automation',
  zoneId: 'z1',
  scopes: ['control:resource:read'],
}

function admin(): AdminClient {
  return {
    zones: {
      list: vi.fn(async () => [{ id: 'z1' }]),
      create: vi.fn(async (body: unknown) => body),
    },
    resources: {
      create: vi.fn(async (_zone: string, body: unknown) => body),
      patch: vi.fn(async (_zone: string, _id: string, body: unknown) => body),
    },
    policySets: {
      addVersion: vi.fn(async () => undefined),
      simulate: vi.fn(async (_zone: string, _id: string, _version: string, input: unknown) => input),
    },
    audit: {
      explain: vi.fn(async () => ({ ok: true })),
    },
  } as unknown as AdminClient
}

describe('validateFlags', () => {
  it('rejects oversized and unsupported flag payloads', () => {
    expect(() => validateFlags(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, true]))))
      .toThrow(/too many flags/)
    expect(() => validateFlags({ '': true })).toThrow(/out of range/)
    expect(() => validateFlags({ long: 'x'.repeat(4097) })).toThrow(/string too long/)
    expect(() => validateFlags({ list: Array.from({ length: 65 }, () => 'x') })).toThrow(/array too long/)
    expect(() => validateFlags({ list: [{}] as never })).toThrow(/unsupported array element/)
    expect(() => validateFlags({ object: {} as never })).toThrow(/unsupported type/)
  })

  it('accepts bounded primitive and array values', () => {
    expect(() => validateFlags({ s: 'x', n: 1, b: true, nil: null, list: ['x', 1, false, null] }))
      .not.toThrow()
  })
})

describe('dispatch', () => {
  it('maps catalog denials and missing required flags to DispatchError codes', async () => {
    await expect(dispatch({ command: 'missing', subcommand: '' }, remote, { admin: admin() }))
      .rejects.toMatchObject({ code: 'denied' })
    await expect(dispatch({ command: 'zone', subcommand: 'missing' }, remote, { admin: admin() }))
      .rejects.toMatchObject({ code: 'denied' })
    await expect(dispatch({ command: 'zone', subcommand: 'create' }, local, { admin: admin() }))
      .rejects.toBeInstanceOf(DispatchError)
  })

  it('denies global zone administration for remote principals', async () => {
    await expect(dispatch({
      command: 'zone',
      subcommand: 'list',
    }, { ...remote, scopes: ['control:zone:read'] }, { admin: admin() }))
      .rejects.toMatchObject({ code: 'denied' })
  })

  it('dispatches resource and policy-set helpers with parsed flag shapes', async () => {
    const a = admin()

    await expect(dispatch({
      command: 'resource',
      subcommand: 'create',
      flags: {
        name: 'Calendar',
        identifier: 'resource://calendar',
        scopes: ['read,write', 'admin'],
        'upstream-url': 'https://calendar.example.com',
      },
    }, local, { admin: a })).resolves.toMatchObject({
      scopes: ['read', 'write', 'admin'],
      upstream_url: 'https://calendar.example.com',
    })

    await expect(dispatch({
      command: 'resource',
      subcommand: 'patch',
      flags: { id: 'res-1', 'upstream-url': null },
    }, local, { admin: a })).resolves.toMatchObject({ upstream_url: null })

    await expect(dispatch({
      command: 'policy-set',
      subcommand: 'version',
      flags: { id: 'ps-1' },
    }, local, { admin: a })).rejects.toMatchObject({ code: 'invalid' })

    await expect(dispatch({
      command: 'policy-set',
      subcommand: 'simulate',
      flags: { id: 'ps-1', version: 'v1', input: '{"principal":{}}' },
    }, local, { admin: a })).resolves.toEqual({ principal: {} })
  })

  it('dispatches explain aliases through audit explain handlers', async () => {
    const a = admin()

    await expect(dispatch({
      command: 'debug',
      subcommand: 'request',
      flags: { 'request-id': 'req-1' },
    }, local, { admin: a })).resolves.toEqual({ ok: true })
    await expect(dispatch({
      command: 'explain',
      subcommand: '',
      flags: { 'request-id': 'req-1' },
    }, local, { admin: a })).resolves.toEqual({ ok: true })
  })
})
