// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for account/org/zone Console link building: identity prefix, sentinel org, and flat-path conversion.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../apps/web/src/platform/state/localInstall', () => ({
  getProfile: () => ({ accountId: 'CRC-AAA-BBB-CCC', fullName: '', displayName: '', avatar: '' }),
  getActiveZoneId: () => 'zone-123',
}))

import { appLink, navTarget, systemZoneViewPath, resolveOrg } from '../../../../apps/web/src/platform/nav/appLink'

const OSS_ORG = 'ORG-0000-0000-0000'

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

describe('systemZoneViewPath', () => {
  it('opens the system zone under the Caracal org with the viewer flag', () => {
    expect(systemZoneViewPath('zone-sys')).toBe('/CRC-AAA-BBB-CCC/ORG-CRC0-SYS0-0001/zone-sys/app?systemZone=1')
  })
})

describe('resolveOrg', () => {
  it('keeps the OSS sentinel and Caracal org, collapses the rest', () => {
    expect(resolveOrg('ORG-0000-0000-0000')).toBe('ORG-0000-0000-0000')
    expect(resolveOrg('ORG-CRC0-SYS0-0001')).toBe('ORG-CRC0-SYS0-0001')
    expect(resolveOrg('ORG-9999-9999-9999')).toBe('ORG-0000-0000-0000')
    expect(resolveOrg(undefined)).toBe('ORG-0000-0000-0000')
  })
})
