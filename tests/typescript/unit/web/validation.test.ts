// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for client-side field validation that mirrors control-plane constraints before submit.

import { describe, expect, it } from 'vitest'

import { validateResourceIdentifier, validateZoneSlug } from '../../../../apps/web/src/platform/api/validation.ts'

describe('validateResourceIdentifier', () => {
  it('treats empty/whitespace as valid (the field is optional and auto-generated)', () => {
    expect(validateResourceIdentifier('')).toBeUndefined()
    expect(validateResourceIdentifier('   ')).toBeUndefined()
  })

  it('accepts an absolute audience URI', () => {
    expect(validateResourceIdentifier('resource://pipernet')).toBeUndefined()
    expect(validateResourceIdentifier('https://api.pipernet.example/v1')).toBeUndefined()
  })

  it('rejects a non-absolute identifier', () => {
    expect(validateResourceIdentifier('pipernet')).toMatch(/absolute URI/)
    expect(validateResourceIdentifier('/relative/path')).toMatch(/absolute URI/)
  })

  it('rejects the provider:// reserved namespace', () => {
    expect(validateResourceIdentifier('provider://hooli-oidc')).toMatch(/provider:\/\/ namespace/)
  })

  it('rejects embedded credentials', () => {
    expect(validateResourceIdentifier('https://user:pass@api.pipernet.example')).toMatch(/embed credentials/)
    expect(validateResourceIdentifier('https://user@api.pipernet.example')).toMatch(/embed credentials/)
  })

  it('trims surrounding whitespace before validating', () => {
    expect(validateResourceIdentifier('  resource://ok  ')).toBeUndefined()
    expect(validateResourceIdentifier('  not-a-uri  ')).toMatch(/absolute URI/)
  })
})

describe('validateZoneSlug', () => {
  it('treats empty as valid (auto-derived)', () => {
    expect(validateZoneSlug('')).toBeUndefined()
    expect(validateZoneSlug('   ')).toBeUndefined()
  })

  it('accepts lowercase letters, numbers, and hyphens', () => {
    expect(validateZoneSlug('pied-piper-prod')).toBeUndefined()
    expect(validateZoneSlug('zone1')).toBeUndefined()
  })

  it('rejects uppercase, spaces, and disallowed punctuation', () => {
    expect(validateZoneSlug('Pied-Piper')).toMatch(/lowercase letters/)
    expect(validateZoneSlug('with space')).toMatch(/lowercase letters/)
    expect(validateZoneSlug('under_score')).toMatch(/lowercase letters/)
    expect(validateZoneSlug('dot.dot')).toMatch(/lowercase letters/)
  })
})
