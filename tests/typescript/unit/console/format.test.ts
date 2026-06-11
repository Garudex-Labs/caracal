// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Time-input resolution converts operator-friendly audit filters into API timestamps.

import { describe, it, expect } from 'vitest'
import { resolveTimeInput } from '../../../../apps/console/src/format.ts'

const now = new Date('2026-06-08T12:00:00.000Z')

describe('resolveTimeInput', () => {
  it('returns undefined for empty input', () => {
    expect(resolveTimeInput(undefined, now)).toBeUndefined()
    expect(resolveTimeInput('', now)).toBeUndefined()
    expect(resolveTimeInput('   ', now)).toBeUndefined()
  })

  it('resolves "now" to the current instant', () => {
    expect(resolveTimeInput('now', now)).toBe('2026-06-08T12:00:00.000Z')
  })

  it('resolves relative windows by subtracting from now', () => {
    expect(resolveTimeInput('30m', now)).toBe('2026-06-08T11:30:00.000Z')
    expect(resolveTimeInput('2h', now)).toBe('2026-06-08T10:00:00.000Z')
    expect(resolveTimeInput('7d', now)).toBe('2026-06-01T12:00:00.000Z')
    expect(resolveTimeInput('1w', now)).toBe('2026-06-01T12:00:00.000Z')
    expect(resolveTimeInput('45s', now)).toBe('2026-06-08T11:59:15.000Z')
  })

  it('preserves an already-canonical ISO timestamp unchanged', () => {
    expect(resolveTimeInput('2026-01-01T00:00:00Z', now)).toBe('2026-01-01T00:00:00Z')
    expect(resolveTimeInput('2026-01-01T00:00:00.500Z', now)).toBe('2026-01-01T00:00:00.500Z')
  })

  it('normalizes a bare date or offset timestamp to UTC', () => {
    expect(resolveTimeInput('2026-06-01', now)).toBe('2026-06-01T00:00:00.000Z')
    expect(resolveTimeInput('2026-06-01T05:00:00+05:00', now)).toBe('2026-06-01T00:00:00.000Z')
  })

  it('throws a clear error for unparseable input', () => {
    expect(() => resolveTimeInput('last tuesday-ish', now)).toThrow(/relative time/)
    expect(() => resolveTimeInput('7x', now)).toThrow(/relative time/)
  })
})
