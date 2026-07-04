/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Unit tests for W3C Trace Context and Baggage envelope encode/decode functions.
 */

import { describe, it, expect } from 'vitest'
import {
  BaggageAgentSession,
  BaggageDelegationEdge,
  BaggageHop,
  HeaderAuthorization,
  HeaderBaggage,
  HeaderTraceparent,
  HeaderTracestate,
  MaxHop,
  decodeEnvelope,
  encodeBaggage,
  encodeEnvelope,
  fromHeaders,
  parseBaggage,
  parseTraceparent,
  toHeaders,
  type Envelope,
} from '../../../../packages/sdk/ts/src/envelope.js'

describe('parseTraceparent', () => {
  it('returns trace id and flags from a valid header', () => {
    expect(parseTraceparent('00-0123456789abcdef0123456789abcdef-0011223344556677-01')).toEqual({
      traceId: '0123456789abcdef0123456789abcdef',
      flags: '01',
    })
  })

  it('accepts future versions with extra fields', () => {
    expect(parseTraceparent('01-0123456789abcdef0123456789abcdef-0011223344556677-00-extra')).toEqual({
      traceId: '0123456789abcdef0123456789abcdef',
      flags: '00',
    })
  })

  it('rejects invalid formats', () => {
    for (const value of [
      '',
      'not-a-traceparent',
      'ff-0123456789abcdef0123456789abcdef-0011223344556677-01',
      '00-0123456789abcdef0123456789abcdef-0011223344556677-01-extra',
      '00-' + '0'.repeat(32) + '-0011223344556677-01',
      '00-0123456789abcdef0123456789abcdef-0000000000000000-01',
      '00-0123456789ABCDEF0123456789abcdef-0011223344556677-01',
    ]) {
      expect(parseTraceparent(value)).toBeUndefined()
    }
  })
})

describe('baggage encoding', () => {
  it('encodes keys in sorted order', () => {
    expect(encodeBaggage({ zeta: '1', alpha: '2', mid: '3' })).toBe('alpha=2,mid=3,zeta=1')
  })

  it('round-trips percent-encoded reserved characters', () => {
    const encoded = encodeBaggage({ k: 'a b%c,d=e' })
    expect(encoded).toBe('k=a%20b%25c%2Cd%3De')
    expect(parseBaggage(encoded)).toEqual({ k: 'a b%c,d=e' })
  })

  it('keeps + literal per W3C Baggage', () => {
    expect(parseBaggage('k=a+b')).toEqual({ k: 'a+b' })
  })

  it('discards headers above the W3C size limits', () => {
    expect(parseBaggage('k=' + 'a'.repeat(9000))).toEqual({})
    const oversized = Array.from({ length: 65 }, (_, i) => `k${i}=v`).join(',')
    expect(parseBaggage(oversized)).toEqual({})
  })
})

describe('decodeEnvelope', () => {
  it('accepts bearer tokens case-insensitively and trimmed', () => {
    for (const raw of ['Bearer tok', 'bearer tok', ' BEARER   tok  ']) {
      const env = decodeEnvelope((n) => (n === HeaderAuthorization ? raw : undefined))
      expect(env.subjectToken).toBe('tok')
    }
  })

  it('ignores non-bearer authorization values', () => {
    for (const raw of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'Bearertok']) {
      const env = decodeEnvelope((n) => (n === HeaderAuthorization ? raw : undefined))
      expect(env.subjectToken).toBeUndefined()
    }
  })

  it('clamps hop and rejects non-digit values', () => {
    const cases: [string, number][] = [
      ['0', 0],
      ['1', 1],
      ['10', MaxHop],
      ['11', MaxHop],
      ['99999999999999999999', MaxHop],
      ['-1', 0],
      ['+3', 0],
      ['3x', 0],
      ['1e2', 0],
      ['1.5', 0],
    ]
    for (const [raw, want] of cases) {
      const env = decodeEnvelope((n) => (n === HeaderBaggage ? `${BaggageHop}=${raw}` : undefined))
      expect(env.hop, `hop=${raw}`).toBe(want)
    }
  })

  it('captures third-party baggage, tracestate, and trace flags', () => {
    const headers: Record<string, string> = {
      [HeaderTraceparent]: '00-0123456789abcdef0123456789abcdef-0011223344556677-00',
      [HeaderTracestate]: 'vendor=value',
      [HeaderBaggage]: `tenant=hooli,${BaggageHop}=1`,
    }
    const env = decodeEnvelope((n) => headers[n])
    expect(env.traceFlags).toBe('00')
    expect(env.traceState).toBe('vendor=value')
    expect(env.baggage).toEqual({ tenant: 'hooli' })
    expect(env.hop).toBe(1)
  })
})

describe('encodeEnvelope', () => {
  it('never emits Authorization', () => {
    const env: Envelope = { subjectToken: 'tok', traceId: '0123456789abcdef0123456789abcdef', hop: 1 }
    const out: Record<string, string> = {}
    encodeEnvelope(env, (k, v) => {
      out[k] = v
    })
    expect(out[HeaderAuthorization]).toBeUndefined()
  })

  it('omits baggage for a root envelope', () => {
    const out: Record<string, string> = {}
    encodeEnvelope({ traceId: '0123456789abcdef0123456789abcdef' }, (k, v) => {
      out[k] = v
    })
    expect(out[HeaderBaggage]).toBeUndefined()
    expect(out[HeaderTraceparent]).toBeDefined()
  })

  it('merges with existing headers instead of clobbering them', () => {
    const existing: Record<string, string> = {
      [HeaderTraceparent]: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab-bbbbbbbbbbbbbbbb-01',
      [HeaderTracestate]: 'otel=span',
      [HeaderBaggage]: `tenant=hooli,${BaggageHop}=9`,
    }
    const env: Envelope = {
      agentSessionId: 'sess',
      traceId: '0123456789abcdef0123456789abcdef',
      traceState: 'caracal=ignored',
      hop: 2,
    }
    encodeEnvelope(
      env,
      (k, v) => {
        existing[k] = v
      },
      (k) => existing[k],
    )
    expect(existing[HeaderTraceparent]).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab-bbbbbbbbbbbbbbbb-01')
    expect(existing[HeaderTracestate]).toBe('otel=span')
    const bag = parseBaggage(existing[HeaderBaggage])
    expect(bag.tenant).toBe('hooli')
    expect(bag[BaggageAgentSession]).toBe('sess')
    expect(bag[BaggageHop]).toBe('2')
    expect(bag[BaggageDelegationEdge]).toBeUndefined()
  })

  it('propagates trace flags into the generated traceparent', () => {
    const out: Record<string, string> = {}
    encodeEnvelope({ traceId: '0123456789abcdef0123456789abcdef', traceFlags: '00', hop: 1 }, (k, v) => {
      out[k] = v
    })
    expect(parseTraceparent(out[HeaderTraceparent])?.flags).toBe('00')
  })
})

describe('toHeaders/fromHeaders', () => {
  it('round-trips the full envelope without the subject token', () => {
    const env: Envelope = {
      subjectToken: 'tok',
      agentSessionId: 'agent-1',
      delegationEdgeId: 'edge-1',
      parentEdgeId: 'parent-1',
      sessionId: 'sid-1',
      traceId: 'a'.repeat(32),
      traceFlags: '00',
      traceState: 'vendor=value',
      baggage: { tenant: 'hooli' },
      hop: 2,
    }
    const headers = toHeaders(env)
    expect(headers[HeaderAuthorization]).toBeUndefined()

    const recovered = fromHeaders(headers)
    expect(recovered.subjectToken).toBeUndefined()
    expect(recovered.agentSessionId).toBe('agent-1')
    expect(recovered.delegationEdgeId).toBe('edge-1')
    expect(recovered.parentEdgeId).toBe('parent-1')
    expect(recovered.sessionId).toBe('sid-1')
    expect(recovered.traceId).toBe('a'.repeat(32))
    expect(recovered.traceFlags).toBe('00')
    expect(recovered.traceState).toBe('vendor=value')
    expect(recovered.baggage).toEqual({ tenant: 'hooli' })
    expect(recovered.hop).toBe(2)
  })

  it('joins repeated baggage values case-insensitively', () => {
    const env = fromHeaders({
      AUTHORIZATION: 'Bearer tok',
      Baggage: [`${BaggageAgentSession}=sess`, 'tenant=hooli'],
    })
    expect(env.subjectToken).toBe('tok')
    expect(env.agentSessionId).toBe('sess')
    expect(env.baggage).toEqual({ tenant: 'hooli' })
  })
})
