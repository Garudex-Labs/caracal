// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for SDK context propagation: bind/current, capture, overrides, and envelope round-trips.

import { describe, it, expect } from 'vitest'
import {
  bind,
  current,
  captureContext,
  withOverrides,
  toEnvelope,
  fromEnvelope,
  describeAuthority,
  type CaracalContext,
} from '../../../../packages/sdk/ts/src/context.js'

function ctx(overrides: Partial<CaracalContext> = {}): CaracalContext {
  return {
    subjectToken: 'tok',
    zoneId: 'zone-1',
    applicationId: 'app-1',
    agentSessionId: 'agent-1',
    sessionId: 'sess-1',
    traceId: 'trace-1',
    hop: 0,
    ...overrides,
  }
}

describe('bind and current', () => {
  it('exposes the bound context inside the callback and clears it outside', async () => {
    expect(current()).toBeUndefined()
    const seen = await bind(ctx(), async () => current())
    expect(seen?.agentSessionId).toBe('agent-1')
    expect(current()).toBeUndefined()
  })
})

describe('captureContext', () => {
  it('returns undefined with no active context', () => {
    expect(captureContext()).toBeUndefined()
  })

  it('returns a detached copy of the active context', async () => {
    await bind(ctx(), async () => {
      const snap = captureContext()
      expect(snap).toEqual(current())
      expect(snap).not.toBe(current())
    })
  })
})

describe('withOverrides', () => {
  it('throws when no base context exists', () => {
    expect(() => withOverrides({ hop: 9 }, () => undefined)).toThrow(/requires an existing/)
  })

  it('merges overrides onto the base context', async () => {
    await bind(ctx(), async () => {
      const merged = await withOverrides({ hop: 5, applicationId: 'app-2' }, async () => current())
      expect(merged?.hop).toBe(5)
      expect(merged?.applicationId).toBe('app-2')
      expect(merged?.zoneId).toBe('zone-1')
    })
  })
})

describe('envelope round-trip', () => {
  it('serializes and restores a context via the envelope', () => {
    const original = ctx({ delegationEdgeId: 'edge-1', parentEdgeId: 'edge-0', hop: 2 })
    const env = toEnvelope(original)
    const restored = fromEnvelope(env, { zoneId: 'zone-1', applicationId: 'app-1' })
    expect(restored).toMatchObject({
      subjectToken: 'tok',
      agentSessionId: 'agent-1',
      delegationEdgeId: 'edge-1',
      parentEdgeId: 'edge-0',
      hop: 2,
    })
  })

  it('rejects an envelope without a subject token', () => {
    expect(() => fromEnvelope({ hop: 0 } as never, { zoneId: 'z', applicationId: 'c' })).toThrow(/missing subject token/)
  })
})

describe('describeAuthority', () => {
  it('returns undefined without a context', () => {
    expect(describeAuthority(undefined)).toBeUndefined()
  })

  it('builds the full authority chain in order', () => {
    const summary = describeAuthority(
      ctx({
        delegationEdgeId: 'edge-1',
        parentEdgeId: 'edge-0',
        hop: 3,
      }),
    )
    expect(summary?.chain).toEqual(['session:sess-1', 'agent-session:agent-1', 'parent-edge:edge-0', 'delegation-edge:edge-1'])
    expect(summary).toMatchObject({ zoneId: 'zone-1', applicationId: 'app-1', hop: 3 })
  })

  it('omits chain segments for absent identifiers', () => {
    const summary = describeAuthority(ctx({ agentSessionId: undefined, sessionId: undefined }))
    expect(summary?.chain).toEqual([])
  })
})
