// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// scrubTokens regex coverage tests.

import { describe, it, expect } from 'vitest'
import { maskSecretField, scrubTokens } from '../../../../apps/tui/src/errors.ts'

describe('scrubTokens', () => {
  it('strips JWT-shaped tokens', () => {
    const out = scrubTokens('boom: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig in body')
    expect(out).not.toMatch(/eyJ/)
    expect(out).toContain('***')
  })

  it('strips caracal access tokens', () => {
    expect(scrubTokens('caracal_at_abc.def-123')).not.toContain('caracal_at_')
  })

  it('strips caracal refresh tokens', () => {
    expect(scrubTokens('caracal_rt_xyz.789')).not.toContain('caracal_rt_')
  })

  it('strips Bearer tokens', () => {
    const out = scrubTokens('Bearer xyz.abc.def something')
    expect(out).not.toMatch(/Bearer xyz/)
    expect(out).toContain('***')
  })

  it('strips Authorization headers', () => {
    const out = scrubTokens('Authorization: secret123 trailing')
    expect(out).not.toMatch(/secret123/)
    expect(out).toContain('Authorization: ***')
  })

  it('masks common secret detail fields', () => {
    expect(maskSecretField('secret-value', ['client_secret'])).toBe('••••')
    expect(maskSecretField('secret-value', ['nested', 'clientSecret'])).toBe('••••')
    expect(maskSecretField('visible', ['name'])).toBeUndefined()
  })
})
