// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator citation presenter: plan steps resolve to Console destinations.

import { describe, it, expect } from 'vitest'
import { planCitations } from '../../../../apps/web/src/platform/operator/citations'
import type { OperatorCapability } from '../../../../apps/web/src/platform/api/types'
import type { PlanItem, PlanStepView } from '../../../../apps/web/src/platform/operator/timeline'

const catalog: OperatorCapability[] = [
  { id: 'createZone', title: 'Create zone', summary: 'Stand up a zone', domain: 'zone', mutating: true },
  { id: 'defineResource', title: 'Define resource', summary: 'Register a resource', domain: 'resource', mutating: true },
  { id: 'listResources', title: 'List resources', summary: 'List resources', domain: 'resource', mutating: false },
]

function step(partial: Partial<PlanStepView> & Pick<PlanStepView, 'id' | 'capability'>): PlanStepView {
  return {
    summary: '',
    mutating: false,
    args: {},
    status: 'pending',
    ...partial,
  }
}

function plan(steps: PlanStepView[]): PlanItem {
  return {
    kind: 'plan',
    id: 'plan-1',
    seq: 1,
    summary: 'Stand up',
    steps,
    decision: 'pending',
    rejectionReason: null,
    executed: false,
    canDecide: true,
    canExecute: false,
  }
}

describe('planCitations', () => {
  it('cites a succeeded mutating step and focuses the item by its name', () => {
    const sources = planCitations(
      plan([
        step({
          id: 's1',
          capability: 'defineResource',
          summary: 'Define PiperNet',
          mutating: true,
          status: 'succeeded',
          args: { name: 'pipernet' },
        }),
      ]),
      catalog,
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      key: 's1',
      title: 'pipernet',
      description: 'Define PiperNet',
      domainLabel: 'Resource',
      to: '/app/resources',
      search: { focus: 'pipernet' },
    })
  })

  it('cites a read-only step immediately and falls back to the capability title', () => {
    const sources = planCitations(plan([step({ id: 's1', capability: 'listResources', mutating: false, status: 'pending' })]), catalog)
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ title: 'List resources', to: '/app/resources', search: {} })
  })

  it('skips a mutating step whose item does not exist yet', () => {
    const sources = planCitations(
      plan([step({ id: 's1', capability: 'defineResource', mutating: true, status: 'pending', args: { name: 'nucleus' } })]),
      catalog,
    )
    expect(sources).toHaveLength(0)
  })

  it('skips a step whose capability is not in the catalog', () => {
    const sources = planCitations(plan([step({ id: 's1', capability: 'unknownThing', mutating: false, status: 'pending' })]), catalog)
    expect(sources).toHaveLength(0)
  })

  it('strips a scheme prefix from the focus slug', () => {
    const sources = planCitations(
      plan([
        step({
          id: 's1',
          capability: 'defineResource',
          mutating: true,
          status: 'succeeded',
          args: { resource_id: 'resource://pipernet' },
        }),
      ]),
      catalog,
    )
    expect(sources[0]).toMatchObject({ title: 'resource://pipernet', search: { focus: 'pipernet' } })
  })

  it('collapses duplicate destinations to a single source', () => {
    const sources = planCitations(
      plan([
        step({ id: 's1', capability: 'defineResource', mutating: true, status: 'succeeded', args: { name: 'pipernet' } }),
        step({ id: 's2', capability: 'defineResource', mutating: true, status: 'succeeded', args: { name: 'pipernet' } }),
      ]),
      catalog,
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].key).toBe('s1')
  })
})
