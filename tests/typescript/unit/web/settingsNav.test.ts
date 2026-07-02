// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Settings navigation model that drives the /settings/{section} pages.

import { describe, expect, it } from 'vitest'

import { featuresByHome, LOCKED_FEATURES } from '../../../../apps/web/src/platform/edition/lockedFeatures.ts'
import { SETTINGS_GROUPS, settingsItem } from '../../../../apps/web/src/platform/nav/settingsNav.ts'

describe('settings navigation model', () => {
  const items = SETTINGS_GROUPS.flatMap((group) => group.items)

  it('gives every group and item a stable id, label, and description', () => {
    for (const group of SETTINGS_GROUPS) {
      expect(group.id, 'group id').toBeTruthy()
      expect(group.label, 'group label').toBeTruthy()
      expect(group.items.length, `items in ${group.id}`).toBeGreaterThan(0)
      for (const item of group.items) {
        expect(item.id, 'item id').toBeTruthy()
        expect(item.label, 'item label').toBeTruthy()
        expect(item.description, 'item description').toBeTruthy()
      }
    }
  })

  it('uses unique ids that are valid single path segments', () => {
    const ids = items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id, `${id} segment`).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it('surfaces every settings-homed enterprise capability as a locked item', () => {
    const lockedIds = items.filter((item) => item.featureSlug).map((item) => item.id)
    const expected = featuresByHome('settings').map((feature) => feature.slug)
    expect(lockedIds.sort()).toEqual(expected.sort())
    for (const slug of lockedIds) {
      expect(LOCKED_FEATURES[slug], `${slug} exists`).toBeTruthy()
    }
  })

  it('resolves items by path segment and rejects unknown segments', () => {
    expect(settingsItem('profile')?.label).toBe('Profile')
    expect(settingsItem('operator')?.label).toBe('AI Operator')
    expect(settingsItem('danger')?.label).toBe('Account deletion')
    expect(settingsItem('nucleus')).toBeUndefined()
    expect(settingsItem('')).toBeUndefined()
  })
})
