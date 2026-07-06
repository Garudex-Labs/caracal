// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Engine dispatcher tests cover bounded flags and command handler edge cases.

import { describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../../../../packages/admin/ts/src/client.js'
import { AdminApiError } from '../../../../packages/admin/ts/src/errors.js'
import { dispatch, DispatchError, validateFlags, type Principal } from '../../../../packages/engine/src/dispatch.js'

const operator: Principal = {
  subject: 'operator',
  zoneId: 'z1',
  scopes: ['control:resource:write', 'control:policy:write', 'control:policy-set:read', 'control:policy-set:write', 'control:explain:read'],
}

const reader: Principal = {
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
    expect(() => validateFlags(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, true])))).toThrow(/too many flags/)
    expect(() => validateFlags({ '': true })).toThrow(/out of range/)
    expect(() => validateFlags({ long: 'x'.repeat(131073) })).toThrow(/string too long/)
    expect(() => validateFlags({ list: Array.from({ length: 65 }, () => 'x') })).toThrow(/array too long/)
    expect(() => validateFlags({ list: [{}] as never })).toThrow(/unsupported array element/)
    expect(() => validateFlags({ object: {} as never })).toThrow(/unsupported type/)
  })

  it('accepts bounded primitive and array values', () => {
    expect(() => validateFlags({ s: 'x', n: 1, b: true, nil: null, list: ['x', 1, false, null] })).not.toThrow()
  })
})

describe('dispatch', () => {
  it('maps catalog denials, missing scopes, and missing required flags to DispatchError codes', async () => {
    await expect(dispatch({ command: 'missing', subcommand: '' }, reader, { admin: admin() })).rejects.toMatchObject({ code: 'denied' })
    await expect(dispatch({ command: 'zone', subcommand: 'list' }, reader, { admin: admin() })).rejects.toMatchObject({ code: 'denied' })
    await expect(dispatch({ command: 'resource', subcommand: 'missing' }, reader, { admin: admin() })).rejects.toMatchObject({
      code: 'denied',
    })
    await expect(dispatch({ command: 'resource', subcommand: 'create', flags: { name: 'Nucleus' } }, reader, { admin: admin() })).rejects.toMatchObject({
      code: 'denied',
    })
    await expect(dispatch({ command: 'resource', subcommand: 'create' }, operator, { admin: admin() })).rejects.toBeInstanceOf(DispatchError)
  })

  it('denies a principal without a zone binding', async () => {
    await expect(
      dispatch(
        {
          command: 'resource',
          subcommand: 'create',
          flags: { name: 'Nucleus', identifier: 'resource://nucleus', scopes: ['read'] },
        },
        { ...operator, zoneId: undefined },
        { admin: admin() },
      ),
    ).rejects.toMatchObject({ code: 'denied' })
  })

  it('dispatches resource and policy-set helpers with parsed flag shapes', async () => {
    const a = admin()

    await expect(
      dispatch(
        {
          command: 'resource',
          subcommand: 'create',
          flags: {
            name: 'Calendar',
            identifier: 'resource://calendar',
            scopes: ['read,write', 'admin'],
            'upstream-url': 'https://calendar.example.com',
          },
        },
        operator,
        { admin: a },
      ),
    ).resolves.toMatchObject({
      scopes: ['read', 'write', 'admin'],
      upstream_url: 'https://calendar.example.com',
    })

    await expect(
      dispatch(
        {
          command: 'resource',
          subcommand: 'patch',
          flags: { id: 'res-1', 'upstream-url': null },
        },
        operator,
        { admin: a },
      ),
    ).resolves.toMatchObject({ upstream_url: null })

    await expect(
      dispatch(
        {
          command: 'policy-set',
          subcommand: 'version',
          flags: { id: 'ps-1' },
        },
        operator,
        { admin: a },
      ),
    ).rejects.toMatchObject({ code: 'invalid' })

    await expect(
      dispatch(
        {
          command: 'policy-set',
          subcommand: 'simulate',
          flags: { id: 'ps-1', version: 'v1', input: '{"principal":{}}' },
        },
        operator,
        { admin: a },
      ),
    ).resolves.toEqual({ principal: {} })
  })

  it('rejects malformed JSON flag values as invalid instead of upstream errors', async () => {
    const a = admin()

    await expect(
      dispatch(
        {
          command: 'policy-set',
          subcommand: 'simulate',
          flags: { id: 'ps-1', version: 'v1', input: '{not json' },
        },
        operator,
        { admin: a },
      ),
    ).rejects.toMatchObject({ code: 'invalid', message: 'flag "input" must be valid JSON' })

    await expect(
      dispatch(
        {
          command: 'resource',
          subcommand: 'create',
          flags: { name: 'Calendar', identifier: 'resource://calendar', scopes: ['read'], operations: '[not json' },
        },
        operator,
        { admin: a },
      ),
    ).rejects.toMatchObject({ code: 'invalid', message: 'flag "operations" must be valid JSON' })
  })

  it('dispatches explain through the audit explain handler', async () => {
    const a = admin()

    await expect(
      dispatch(
        {
          command: 'explain',
          subcommand: '',
          flags: { 'request-id': 'req-1' },
        },
        operator,
        { admin: a },
      ),
    ).resolves.toEqual({ ok: true })
  })

  it('translates a control-plane rejection into a structured DispatchError carrying the real reason', async () => {
    const a = admin()
    a.policies = {
      create: vi.fn(async () => {
        throw new AdminApiError(422, 'invalid_rego', {
          error: 'invalid_rego',
          error_description: 'rego_parse_error: unexpected token',
        })
      }),
    } as unknown as AdminClient['policies']

    await expect(
      dispatch(
        {
          command: 'policy',
          subcommand: 'create',
          flags: { name: 'PiperNet baseline', content: 'package caracal.authz' },
        },
        operator,
        { admin: a },
      ),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'invalid_rego: rego_parse_error: unexpected token',
    })
  })

  it('keeps an ambiguous upstream failure as an upstream DispatchError so the plan is not retried', async () => {
    const a = admin()
    a.policies = {
      create: vi.fn(async () => {
        throw new AdminApiError(503, 'service_unavailable', { error: 'service_unavailable' })
      }),
    } as unknown as AdminClient['policies']

    await expect(
      dispatch(
        {
          command: 'policy',
          subcommand: 'create',
          flags: { name: 'PiperNet baseline', content: 'package caracal.authz' },
        },
        operator,
        { admin: a },
      ),
    ).rejects.toMatchObject({ code: 'upstream' })
  })
})
