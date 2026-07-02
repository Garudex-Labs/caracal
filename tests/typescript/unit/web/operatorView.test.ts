// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator view presenters: session bucketing, suggestion selection, plan decision-state mapping, and error messaging.

import { describe, it, expect } from 'vitest'
import {
  advisoryTone,
  alignmentVerdict,
  decideErrorMessage,
  deriveTitle,
  executeErrorMessage,
  formatRelative,
  groupConversations,
  leadSuggestion,
  planApproval,
  planConfirmationState,
  planDecision,
  stepToolState,
  streamWindow,
} from '../../../../apps/web/src/platform/operator/view'
import type { OperatorConversation } from '../../../../apps/web/src/platform/api/types'
import type { PlanItem, PlanStepView } from '../../../../apps/web/src/platform/operator/timeline'

function step(partial: Partial<PlanStepView> & Pick<PlanStepView, 'id' | 'capability'>): PlanStepView {
  return {
    summary: '',
    mutating: false,
    args: {},
    status: 'pending',
    dependsOn: [],
    ...partial,
  }
}

function plan(partial: Partial<PlanItem> = {}): PlanItem {
  return {
    kind: 'plan',
    id: 'plan-1',
    seq: 1,
    summary: 'Stand up',
    steps: [],
    decision: 'pending',
    rejectionReason: null,
    executed: false,
    canDecide: true,
    canExecute: false,
    approvedByAutopilot: false,
    ...partial,
  }
}

function conversation(id: string, lastActivityAt: string): OperatorConversation {
  return { id, last_activity_at: lastActivityAt } as OperatorConversation
}

describe('leadSuggestion', () => {
  it('leads with registering an application when the zone has none', () => {
    expect(leadSuggestion(false)).toBe('registerApp')
  })
  it('leads with granting access once applications exist', () => {
    expect(leadSuggestion(true)).toBe('grant')
  })
})

describe('deriveTitle', () => {
  it('collapses whitespace', () => {
    expect(deriveTitle('  give   Fiona\n read ')).toBe('give Fiona read')
  })
  it('truncates with an ellipsis past 48 characters', () => {
    const title = deriveTitle('a'.repeat(60))
    expect(title.length).toBe(48)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('formatRelative', () => {
  it('returns the raw value for an unparseable date', () => {
    expect(formatRelative('not-a-date')).toBe('not-a-date')
  })
  it('reports just now for a fresh timestamp', () => {
    expect(formatRelative(new Date().toISOString())).toBe('just now')
  })
  it('reports minutes, hours, and days', () => {
    const now = Date.now()
    expect(formatRelative(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago')
    expect(formatRelative(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h ago')
    expect(formatRelative(new Date(now - 2 * 86_400_000).toISOString())).toBe('2d ago')
  })
})

describe('groupConversations', () => {
  it('buckets by last activity and drops empty buckets, preserving order', () => {
    const now = Date.now()
    const today = new Date(now - 60_000).toISOString()
    const yesterday = new Date(now - 30 * 3_600_000).toISOString()
    const older = new Date(now - 60 * 86_400_000).toISOString()
    const groups = groupConversations([
      conversation('a', today),
      conversation('b', today),
      conversation('c', yesterday),
      conversation('d', older),
    ])
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Older'])
    expect(groups[0].items.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('planDecision', () => {
  it('marks an executed approval as applied', () => {
    expect(planDecision(plan({ decision: 'approved', executed: true }))).toEqual({ tone: 'success', label: 'Applied' })
  })
  it('distinguishes an autopilot approval', () => {
    expect(planDecision(plan({ decision: 'approved', approvedByAutopilot: true }))).toEqual({
      tone: 'success',
      label: 'Approved by autopilot',
    })
  })
  it('labels a human approval', () => {
    expect(planDecision(plan({ decision: 'approved' }))).toEqual({ tone: 'success', label: 'Approved' })
  })
  it('labels rejection and pending', () => {
    expect(planDecision(plan({ decision: 'rejected' }))).toEqual({ tone: 'danger', label: 'Rejected' })
    expect(planDecision(plan({ decision: 'pending' }))).toEqual({ tone: 'warning', label: 'Awaiting approval' })
  })
})

describe('stepToolState', () => {
  const s = step({ id: 's1', capability: 'createZone' })
  it('denies every step of a rejected plan', () => {
    expect(stepToolState(s, plan({ decision: 'rejected' }))).toBe('output-denied')
  })
  it('reports per-step success and failure', () => {
    expect(stepToolState(step({ id: 's1', capability: 'x', status: 'succeeded' }), plan())).toBe('output-available')
    expect(stepToolState(step({ id: 's1', capability: 'x', status: 'failed' }), plan())).toBe('output-error')
  })
  it('treats an undecided step as pending', () => {
    expect(stepToolState(s, plan())).toBe('input-streaming')
  })
})

describe('planApproval', () => {
  it('encodes an approval', () => {
    expect(planApproval(plan({ decision: 'approved' }))).toEqual({ id: 'plan-1', approved: true })
  })
  it('encodes a rejection with reason', () => {
    expect(planApproval(plan({ decision: 'rejected', rejectionReason: 'too broad' }))).toEqual({
      id: 'plan-1',
      approved: false,
      reason: 'too broad',
    })
  })
  it('omits a missing reason', () => {
    expect(planApproval(plan({ decision: 'rejected' }))).toEqual({ id: 'plan-1', approved: false })
  })
  it('leaves a pending plan undecided', () => {
    expect(planApproval(plan({ decision: 'pending' }))).toEqual({ id: 'plan-1' })
  })
})

describe('planConfirmationState', () => {
  it('requests approval while pending', () => {
    expect(planConfirmationState(plan({ decision: 'pending' }))).toBe('approval-requested')
  })
  it('denies a rejected plan', () => {
    expect(planConfirmationState(plan({ decision: 'rejected' }))).toBe('output-denied')
  })
  it('reports an applied or responded approval', () => {
    expect(planConfirmationState(plan({ decision: 'approved', executed: true }))).toBe('output-available')
    expect(planConfirmationState(plan({ decision: 'approved' }))).toBe('approval-responded')
  })
})

describe('advisoryTone', () => {
  it('maps severities to tones', () => {
    expect(advisoryTone('warning')).toBe('danger')
    expect(advisoryTone('caution')).toBe('warning')
    expect(advisoryTone('info')).toBe('muted')
  })
})

describe('alignmentVerdict', () => {
  it('maps verdicts to labels and tones', () => {
    expect(alignmentVerdict('aligned')).toEqual({ label: 'Aligned', tone: 'success' })
    expect(alignmentVerdict('risky')).toEqual({ label: 'Needs care', tone: 'warning' })
    expect(alignmentVerdict('misaligned')).toEqual({ label: 'Misaligned', tone: 'danger' })
  })
})

describe('executeErrorMessage', () => {
  it('names known execution failures', () => {
    expect(executeErrorMessage({ code: 'plan_already_executed' })).toBe('This plan was already applied.')
    expect(executeErrorMessage({ code: 'zone_forbidden' })).toContain('internal to Caracal')
    expect(executeErrorMessage({ code: 'plan_blocked' })).toContain("can't be applied")
  })
  it('falls back for unknown codes', () => {
    expect(executeErrorMessage({ code: 'mystery' })).toBe("Couldn't apply the changes. Please try again.")
    expect(executeErrorMessage(null)).toBe("Couldn't apply the changes. Please try again.")
  })
})

describe('decideErrorMessage', () => {
  it('names known decision failures', () => {
    expect(decideErrorMessage({ code: 'plan_already_decided' })).toContain('already decided')
    expect(decideErrorMessage({ code: 'plan_not_found' })).toBe('This plan is no longer available.')
  })
  it('falls back for unknown codes', () => {
    expect(decideErrorMessage({ code: 'mystery' })).toBe("Couldn't record the decision. Please try again.")
    expect(decideErrorMessage(undefined)).toBe("Couldn't record the decision. Please try again.")
  })
})

describe('streamWindow', () => {
  const items = [1, 2, 3, 4, 5]
  it('returns every item when the window covers the whole transcript', () => {
    expect(streamWindow(items, 5)).toEqual(items)
    expect(streamWindow(items, 99)).toEqual(items)
  })
  it('returns the tail slice in order when the window is smaller', () => {
    expect(streamWindow(items, 2)).toEqual([4, 5])
    expect(streamWindow(items, 3)).toEqual([3, 4, 5])
  })
  it('always keeps the newest item in the window', () => {
    expect(streamWindow(items, 1)).toEqual([5])
  })
  it('handles an empty transcript', () => {
    expect(streamWindow([], 4)).toEqual([])
  })
})
