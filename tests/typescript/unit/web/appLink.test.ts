// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for account/org/zone Console link building: identity prefix, sentinel org, and flat-path conversion.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../apps/web/src/platform/state/localInstall', () => ({
  getProfile: () => ({ accountId: 'CRC-AAA-BBB-CCC', fullName: '', displayName: '', avatar: '' }),
  getActiveZoneId: () => 'zone-123',
}))

import { appLink, navTarget } from '../../../../apps/web/src/platform/nav/appLink'

const OSS_ORG = '00000000-0000-0000-0000-000000000000'

describe('appLink', () => {
  it('builds account/org/zone prefixed app root', () => {
    expect(appLink()).toBe(`/CRC-AAA-BBB-CCC/${OSS_ORG}/zone-123/app`)
  })

  it('appends a sub-path', () => {
    expect(appLink('/audit')).toBe(`/CRC-AAA-BBB-CCC/${OSS_ORG}/zone-123/app/audit`)
  })

  it('honours an explicit zone id', () => {
    expect(appLink('/settings', 'zone-9')).toBe(`/CRC-AAA-BBB-CCC/${OSS_ORG}/zone-9/app/settings`)
  })
})

describe('navTarget', () => {
  it('maps the flat dashboard to the prefixed root', () => {
    expect(navTarget('/app')).toBe(`/CRC-AAA-BBB-CCC/${OSS_ORG}/zone-123/app`)
  })

  it('maps a flat sub-path', () => {
    expect(navTarget('/app/zones')).toBe(`/CRC-AAA-BBB-CCC/${OSS_ORG}/zone-123/app/zones`)
  })
})
