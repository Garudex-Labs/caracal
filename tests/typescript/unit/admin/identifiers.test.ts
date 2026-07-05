// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Admin SDK identifier helper tests for provider and resource audience strings.

import { describe, expect, it } from 'vitest'
import {
  isProviderIdentifier,
  isResourceIdentifier,
  providerIdentifier,
  resourceIdentifier,
} from '../../../../packages/admin/ts/src/index.js'

describe('admin identifier helpers', () => {
  it('normalizes provider identifiers into the provider namespace', () => {
    expect(providerIdentifier('Hooli OIDC')).toBe('provider://hooli-oidc')
    expect(providerIdentifier('provider://Hooli OIDC')).toBe('provider://hooli-oidc')
    expect(providerIdentifier(`---${'---'.repeat(2000)}Hooli---OIDC${'---'.repeat(2000)}---`)).toBe('provider://hooli-oidc')
    expect(isProviderIdentifier('provider://hooli-oidc')).toBe(true)
    expect(isProviderIdentifier('resource://hooli-oidc')).toBe(false)
  })

  it('normalizes resource identifiers without entering the provider namespace', () => {
    expect(resourceIdentifier('Calendar API')).toBe('resource://calendar-api')
    expect(resourceIdentifier('https://api.hooli.example/calendar')).toBe('https://api.hooli.example/calendar')
    expect(isResourceIdentifier('provider://hooli-oidc')).toBe(false)
    expect(isResourceIdentifier('caracal-control', 'caracal-control')).toBe(true)
  })
})
