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
    sessionId: 'agent-1',
    subjectAuthorityRecordId: 'sess-1',
    traceId: 'trace-1',
    hop: 0,
    ...overrides,
  }
}

describe('bind and current', () => {
  it('exposes the bound context inside the callback and clears it outside', async () => {
    expect(current()).toBeUndefined()
    const seen = await bind(ctx(), async () => current())
    expect(seen?.sessionId).toBe('agent-1')
    expect(current()).toBeUndefined()
  })

  it('isolates concurrent bind scopes from each other', async () => {
    const seen = await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        bind(ctx({ sessionId: `agent-${id}` }), async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return current()?.sessionId
        }),
      ),
    )
    expect(seen).toEqual(['agent-a', 'agent-b', 'agent-c'])
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

  it('clones baggage so the snapshot cannot mutate the bound context', async () => {
    await bind(ctx({ baggage: { tenant: 'piedpiper' } }), async () => {
      const snap = captureContext()
      snap!.baggage!.tenant = 'hooli'
      expect(current()?.baggage?.tenant).toBe('piedpiper')
    })
  })
})

describe('withOverrides', () => {
  it('throws when no base context exists', () => {
    expect(() => withOverrides({ hop: 9 })).toThrow(/requires an existing/)
  })

  it('returns a merged copy without mutating the bound context', async () => {
    await bind(ctx(), async () => {
      const merged = withOverrides({ hop: 5, applicationId: 'app-2' })
      expect(merged.hop).toBe(5)
      expect(merged.applicationId).toBe('app-2')
      expect(merged.zoneId).toBe('zone-1')
      expect(current()?.hop).toBe(0)
      expect(current()?.applicationId).toBe('app-1')
    })
  })

  it('clones baggage so the copy cannot mutate the base', async () => {
    await bind(ctx({ baggage: { tenant: 'piedpiper' } }), async () => {
      const merged = withOverrides({ hop: 1 })
      merged.baggage!.tenant = 'hooli'
      expect(current()?.baggage?.tenant).toBe('piedpiper')
    })
  })
})

describe('envelope round-trip', () => {
  it('serializes and restores a context via the envelope', () => {
    const original = ctx({ delegationId: 'edge-1', parentDelegationId: 'edge-0', hop: 2 })
    const env = toEnvelope(original)
    const restored = fromEnvelope(env, { zoneId: 'zone-1', applicationId: 'app-1' })
    expect(restored).toMatchObject({
      subjectToken: 'tok',
      sessionId: 'agent-1',
      delegationId: 'edge-1',
      parentDelegationId: 'edge-0',
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
        delegationId: 'edge-1',
        parentDelegationId: 'edge-0',
        hop: 3,
      }),
    )
    expect(summary?.chain).toEqual(['subject:sess-1', 'session:agent-1', 'parent-delegation:edge-0', 'delegation:edge-1'])
    expect(summary).toMatchObject({ zoneId: 'zone-1', applicationId: 'app-1', hop: 3 })
  })

  it('omits chain segments for absent identifiers', () => {
    const summary = describeAuthority(ctx({ sessionId: undefined, subjectAuthorityRecordId: undefined }))
    expect(summary?.chain).toEqual([])
  })
})
