// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Console navigation model and enterprise feature gating shown to Community operators.

import { describe, expect, it } from 'vitest'

import { NAV_GROUPS } from '../../../../apps/web/src/platform/nav/navModel.ts'
import {
  ENTERPRISE_FEATURES,
  LOCKED_FEATURES,
  featuresByHome,
  type FeatureHome,
} from '../../../../apps/web/src/platform/edition/lockedFeatures.ts'

describe('navigation model', () => {
  const items = NAV_GROUPS.flatMap((group) => group.items)

  it('gives every group and item a stable id, label, and absolute route', () => {
    for (const group of NAV_GROUPS) {
      expect(group.id, 'group id').toBeTruthy()
      expect(group.label, 'group label').toBeTruthy()
      expect(group.items.length, `items in ${group.id}`).toBeGreaterThan(0)
      for (const item of group.items) {
        expect(item.id, 'item id').toBeTruthy()
        expect(item.label, 'item label').toBeTruthy()
        expect(item.to.startsWith('/app'), `${item.id} route`).toBe(true)
      }
    }
  })

  it('uses unique ids and routes across the whole model', () => {
    const ids = items.map((i) => i.id)
    const routes = items.map((i) => i.to)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(routes).size).toBe(routes.length)
  })

  it('routes every locked item into the enterprise namespace', () => {
    for (const item of items.filter((i) => i.locked)) {
      expect(item.to, `${item.id} locked route`).toContain('/app/enterprise/')
    }
  })

  it('keeps the dashboard unscoped while resource surfaces are zone-scoped', () => {
    const dashboard = items.find((i) => i.id === 'dashboard')
    expect(dashboard?.zoneScoped).toBeFalsy()
    for (const id of ['applications', 'providers', 'resources', 'policies', 'agents', 'audit', 'services']) {
      expect(items.find((i) => i.id === id)?.zoneScoped, `${id} zoneScoped`).toBe(true)
    }
  })
})

describe('enterprise locked features', () => {
  it('gives each feature a complete upsell record keyed by its own slug', () => {
    for (const [key, feature] of Object.entries(LOCKED_FEATURES)) {
      expect(feature.slug).toBe(key)
      expect(feature.title).toBeTruthy()
      expect(feature.summary).toBeTruthy()
      expect(feature.value.length, `${key} value`).toBeGreaterThan(0)
      expect(feature.includes.length, `${key} includes`).toBeGreaterThan(0)
      expect(feature.community, `${key} community note`).toBeTruthy()
    }
  })

  it('exposes every feature through ENTERPRISE_FEATURES', () => {
    expect(ENTERPRISE_FEATURES.length).toBe(Object.keys(LOCKED_FEATURES).length)
  })

  it('partitions features by home, covering all of them and nothing foreign', () => {
    const homes: FeatureHome[] = ['settings', 'observability', 'policy']
    const collected = homes.flatMap((home) => {
      const list = featuresByHome(home)
      for (const f of list) expect(f.home).toBe(home)
      return list
    })
    expect(collected.length).toBe(ENTERPRISE_FEATURES.length)
  })

  it('returns an empty list for a home with no features', () => {
    expect(featuresByHome('nonexistent' as FeatureHome)).toEqual([])
  })
})
