// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for hide-locked navigation: pages presented as if they do not exist in the system-zone view.

import { describe, it, expect } from 'vitest'
import { isHideLockedPath } from '../../../../apps/web/src/platform/nav/hideLock'

describe('isHideLockedPath', () => {
  it('hide-locks the enterprise, Operator, and settings surfaces in the system-zone view', () => {
    expect(isHideLockedPath('/app/ai', true)).toBe(true)
    expect(isHideLockedPath('/app/settings', true)).toBe(true)
    expect(isHideLockedPath('/app/enterprise/governance', true)).toBe(true)
    expect(isHideLockedPath('/app/enterprise/analytics', true)).toBe(true)
  })

  it('matches nested paths under a hide-locked prefix', () => {
    expect(isHideLockedPath('/app/ai/conversation/123', true)).toBe(true)
    expect(isHideLockedPath('/app/settings/profile', true)).toBe(true)
  })

  it('does not hide-lock anything outside the system-zone view', () => {
    expect(isHideLockedPath('/app/ai', false)).toBe(false)
    expect(isHideLockedPath('/app/settings', false)).toBe(false)
    expect(isHideLockedPath('/app/enterprise/governance', false)).toBe(false)
  })

  it('leaves the core console surfaces reachable in the system-zone view', () => {
    expect(isHideLockedPath('/app', true)).toBe(false)
    expect(isHideLockedPath('/app/applications', true)).toBe(false)
    expect(isHideLockedPath('/app/policies', true)).toBe(false)
    expect(isHideLockedPath('/app/audit', true)).toBe(false)
  })

  it('does not match look-alike prefixes', () => {
    expect(isHideLockedPath('/app/aircraft', true)).toBe(false)
    expect(isHideLockedPath('/app/settings-export', true)).toBe(false)
  })
})
