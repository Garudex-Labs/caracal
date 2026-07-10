// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for client-side field validation that mirrors control-plane constraints before submit.

import { describe, expect, it } from 'vitest'

import {
  stripResourceIdentifierPrefix,
  validateResourceIdentifier,
  validateZoneSlug,
} from '../../../../apps/web/src/platform/api/validation.ts'

describe('validateResourceIdentifier', () => {
  it('treats empty/whitespace as valid (the field is optional and auto-generated)', () => {
    expect(validateResourceIdentifier('')).toBeUndefined()
    expect(validateResourceIdentifier('   ')).toBeUndefined()
  })

  it('accepts a lowercase slug after the locked prefix', () => {
    expect(validateResourceIdentifier('pipernet')).toBeUndefined()
    expect(validateResourceIdentifier('not-hotdog')).toBeUndefined()
    expect(validateResourceIdentifier('nucleus2')).toBeUndefined()
  })

  it('rejects uppercase, spaces, and disallowed punctuation', () => {
    expect(validateResourceIdentifier('PiperNet')).toMatch(/lowercase letters/)
    expect(validateResourceIdentifier('with space')).toMatch(/lowercase letters/)
    expect(validateResourceIdentifier('under_score')).toMatch(/lowercase letters/)
    expect(validateResourceIdentifier('dot.dot')).toMatch(/lowercase letters/)
  })

  it('rejects leading, trailing, and doubled hyphens', () => {
    expect(validateResourceIdentifier('-pipernet')).toMatch(/lowercase letters/)
    expect(validateResourceIdentifier('pipernet-')).toMatch(/lowercase letters/)
    expect(validateResourceIdentifier('piper--net')).toMatch(/lowercase letters/)
  })

  it('trims surrounding whitespace before validating', () => {
    expect(validateResourceIdentifier('  pipernet  ')).toBeUndefined()
    expect(validateResourceIdentifier('  Piper Net  ')).toMatch(/lowercase letters/)
  })
})

describe('stripResourceIdentifierPrefix', () => {
  it('removes the locked prefix from pasted full identifiers', () => {
    expect(stripResourceIdentifierPrefix('resource://pipernet')).toBe('pipernet')
  })

  it('leaves bare slugs untouched', () => {
    expect(stripResourceIdentifierPrefix('pipernet')).toBe('pipernet')
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
