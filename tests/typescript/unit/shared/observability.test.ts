// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for trace context, cloud-secret redaction, and dev-log metrics.

import { describe, expect, it } from 'vitest'
import {
  parseTraceparent,
  runWithTrace,
  getTraceContext,
  redactString,
  truncateString,
  MAX_FIELD_BYTES,
  traceMixin,
} from '../../../../packages/core/ts/src/logging.js'

describe('parseTraceparent', () => {
  it('extracts trace and span ids', () => {
    const tc = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')
    expect(tc).toEqual({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' })
  })
  it('returns empty for malformed input', () => {
    expect(parseTraceparent('garbage')).toEqual({})
    expect(parseTraceparent(undefined)).toEqual({})
  })
})

describe('trace context propagation', () => {
  it('binds the context to the async chain', async () => {
    let inner: ReturnType<typeof getTraceContext>
    await runWithTrace({ traceId: 't', spanId: 's' }, async () => {
      await Promise.resolve()
      inner = getTraceContext()
    })
    expect(inner).toEqual({ traceId: 't', spanId: 's' })
    expect(getTraceContext()).toBeUndefined()
  })

  it('traceMixin returns trace fields when bound', () => {
    const mixin = traceMixin()
    runWithTrace({ traceId: 't1', spanId: 's1' }, () => {
      expect(mixin()).toEqual({ trace_id: 't1', span_id: 's1' })
    })
    expect(mixin()).toEqual({})
  })
})

describe('cloud secret redaction', () => {
  it('scrubs known provider patterns', () => {
    expect(redactString('AKIA1234567890ABCDEF')).toBe('***')
    expect(redactString('ghp_1234567890abcdefghij1234567890abcdefgh')).toBe('***')
    expect(redactString('AIzaSyA-1234567890abcdefghijklmnopqrstuvw')).toContain('***')
    expect(redactString('xoxb-12345-67890-abcdefghijklmnop')).toBe('***')
  })

  it('scrubs PEM private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD\n-----END RSA PRIVATE KEY-----'
    expect(redactString(pem)).toBe('***')
  })
})

describe('field truncation', () => {
  it('caps strings longer than MAX_FIELD_BYTES', () => {
    const big = 'x'.repeat(MAX_FIELD_BYTES + 100)
    const out = truncateString(big)
    expect(out.endsWith('[truncated]')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(MAX_FIELD_BYTES + 20)
  })
  it('leaves short strings untouched', () => {
    expect(truncateString('short')).toBe('short')
  })
})
