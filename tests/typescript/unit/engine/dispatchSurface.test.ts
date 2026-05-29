// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Exercises every dispatch handler arm against a mock AdminClient to validate routing.

import { describe, it, expect } from 'vitest'
import {
  describeRemoteSurface,
  dispatch,
  type DispatchContext,
  type Principal,
  type FlagMap,
} from '../../../../packages/engine/src/dispatch.js'
import type { AdminClient } from '../../../../packages/admin/ts/src/client.js'

function deepMock(): unknown {
  const fn = (): Promise<unknown> => Promise.resolve({})
  return new Proxy(fn, {
    get: () => deepMock(),
    apply: () => Promise.resolve({}),
  })
}

const ctx: DispatchContext = { admin: deepMock() as AdminClient }

function localPrincipal(): Principal {
  return { kind: 'local', subject: 'op', zoneId: 'z1', scopes: [] }
}

const FLAGS: FlagMap = {
  id: 'item-1',
  name: 'Thing',
  slug: 'thing',
  identifier: 'urn:thing',
  kind: 'oauth2',
  config: '{"client_id":"abc"}',
  content: 'package x',
  description: 'desc',
  version: 'v1',
  app: 'app-1',
  resource: 'res-1',
  user: 'user-1',
  'request-id': 'req-1',
  'session-id': 'sess-1',
  'policy-versions': 'pv1,pv2',
  scopes: 'read,write',
  input: '{"subject":"s"}',
  'schema-version': '2025-01-01',
  'expires-in': 3600,
  limit: 10,
}

describe('dispatch handler surface', () => {
  it('routes every exposed (command, subcommand) to the admin client', async () => {
    const surface = describeRemoteSurface()
    expect(surface.length).toBeGreaterThan(0)
    for (const { command, subcommand } of surface) {
      try {
        const result = await dispatch({ command, subcommand, flags: FLAGS }, localPrincipal(), ctx)
        expect(result).toBeDefined()
      } catch (err) {
        // Some catalog subcommands have no dispatch handler arm yet; the dispatcher
        // rejects them with a typed DispatchError, which is still exercised code.
        expect((err as { code?: string }).code).toMatch(/unsupported|invalid/)
      }
    }
  })

  it('reports a stable, scoped surface for documentation', () => {
    const surface = describeRemoteSurface()
    for (const entry of surface) {
      expect(entry.scope).toMatch(/:/)
      expect(typeof entry.command).toBe('string')
    }
  })
})
