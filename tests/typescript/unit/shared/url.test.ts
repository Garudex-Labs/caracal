// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs

import { describe, expect, it } from 'vitest'
import { pathOnly } from '../../../../packages/core/ts/src/url.js'

describe('pathOnly', () => {
  it('returns the path unchanged when there is no query', () => {
    expect(pathOnly('/v1/zones/foo')).toBe('/v1/zones/foo')
    expect(pathOnly('/')).toBe('/')
    expect(pathOnly('')).toBe('')
  })

  it('strips query and fragment-looking suffix after ?', () => {
    expect(pathOnly('/v1/foo?bar=1')).toBe('/v1/foo')
    expect(pathOnly('/x?')).toBe('/x')
  })
})
