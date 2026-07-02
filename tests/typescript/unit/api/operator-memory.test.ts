// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for deterministic conversation memory: history compression and fact rendering.

import { describe, it, expect } from 'vitest'
import { summarizeHistory, describeFacts } from '../../../../apps/api/src/operator-memory.js'
import type { TurnRecord } from '../../../../apps/api/src/operator-state.js'

function turn(partial: Partial<TurnRecord> & Pick<TurnRecord, 'seq' | 'kind'>): TurnRecord {
  return { role: 'operator', content: {}, ...partial } as TurnRecord
}

function plan(seq: number, capabilities: string[], summary = `plan ${seq}`): TurnRecord {
  return turn({
    seq,
    kind: 'plan',
    content: { summary, steps: capabilities.map((capability, i) => ({ id: `s${i + 1}`, capability })) },
  })
}

describe('summarizeHistory', () => {
  it('returns empty facts for an empty history', () => {
    expect(summarizeHistory([])).toEqual({
      decided_plans: [],
      rejected_capabilities: [],
      applied_change_count: 0,
      last_drift: null,
      last_error: null,
    })
  })

  it('omits an undecided plan from the facts', () => {
    const facts = summarizeHistory([plan(1, ['createZone'])])
    expect(facts.decided_plans).toEqual([])
  })

  it('summarizes an approved, executed plan with its outcome', () => {
    const facts = summarizeHistory([
      plan(1, ['createZone', 'registerApplication']),
      turn({ seq: 2, kind: 'approval', content: { plan_seq: 1 } }),
      turn({ seq: 3, kind: 'execution', content: { plan_seq: 1, step_id: 's1', status: 'succeeded' } }),
      turn({ seq: 4, kind: 'execution', content: { plan_seq: 1, step_id: 's2', status: 'failed' } }),
    ])
    expect(facts.decided_plans[0]).toMatchObject({
      seq: 1,
      decision: 'approved',
      executed: true,
      steps_succeeded: 1,
      steps_failed: 1,
    })
    expect(facts.applied_change_count).toBe(1)
  })

  it('records rejected capabilities as rejection memory', () => {
    const facts = summarizeHistory([
      plan(1, ['grantAccess', 'connectProvider']),
      turn({ seq: 2, kind: 'rejection', content: { plan_seq: 1, reason: 'too broad' } }),
    ])
    expect(facts.rejected_capabilities).toEqual(['connectProvider', 'grantAccess'])
    expect(facts.decided_plans[0]).toMatchObject({ decision: 'rejected', executed: false })
  })

  it('tracks the most recent error', () => {
    const facts = summarizeHistory([
      turn({ seq: 1, kind: 'error', role: 'system', content: { message: 'first' } }),
      turn({ seq: 2, kind: 'error', role: 'system', content: { message: 'second' } }),
    ])
    expect(facts.last_error).toEqual({ seq: 2, message: 'second' })
  })

  it('carries a verification verdict that reported drift so the planner can reconcile it', () => {
    const facts = summarizeHistory([
      plan(1, ['registerApplication']),
      turn({ seq: 2, kind: 'approval', content: { plan_seq: 1 } }),
      turn({ seq: 3, kind: 'execution', content: { plan_seq: 1, step_id: 's1', status: 'succeeded' } }),
      turn({
        seq: 4,
        kind: 'note',
        content: {
          text: 'Verification (drifted): the app is missing.',
          verification: { status: 'drifted', summary: 'The Billing application is not present.' },
        },
      }),
    ])
    expect(facts.last_drift).toEqual({ seq: 4, summary: 'The Billing application is not present.' })
  })

  it('drops the drift signal once a later verification matches, so a reconciled drift is not carried', () => {
    const facts = summarizeHistory([
      turn({
        seq: 1,
        kind: 'note',
        content: { verification: { status: 'drifted', summary: 'Resource missing.' } },
      }),
      turn({
        seq: 2,
        kind: 'note',
        content: { verification: { status: 'matched', summary: 'Resource now present.' } },
      }),
    ])
    expect(facts.last_drift).toBeNull()
  })

  it('ignores a plain note that carries no verification verdict', () => {
    const facts = summarizeHistory([turn({ seq: 1, kind: 'note', content: { text: 'why was it denied' } })])
    expect(facts.last_drift).toBeNull()
  })

  it('caps the decided plans to the most recent, bounding output for long sessions', () => {
    const turns: TurnRecord[] = []
    let seq = 1
    for (let i = 0; i < 15; i++) {
      turns.push(plan(seq, ['createZone'], `plan ${i}`))
      turns.push(turn({ seq: seq + 1, kind: 'approval', content: { plan_seq: seq } }))
      seq += 2
    }
    const facts = summarizeHistory(turns, { planCap: 10 })
    expect(facts.decided_plans).toHaveLength(10)
    // The cap keeps the most recent plans.
    expect(facts.decided_plans[facts.decided_plans.length - 1].summary).toBe('plan 14')
    expect(facts.decided_plans[0].summary).toBe('plan 5')
  })

  it('folds turns regardless of input ordering', () => {
    const facts = summarizeHistory([turn({ seq: 2, kind: 'approval', content: { plan_seq: 1 } }), plan(1, ['createZone'])])
    expect(facts.decided_plans[0]).toMatchObject({ seq: 1, decision: 'approved' })
  })
})

describe('describeFacts', () => {
  it('returns an empty string when there is nothing to carry', () => {
    expect(describeFacts(null)).toBe('')
    expect(
      describeFacts({ decided_plans: [], rejected_capabilities: [], applied_change_count: 0, last_drift: null, last_error: null }),
    ).toBe('')
  })

  it('renders a compact block with applied changes and rejection memory', () => {
    const text = describeFacts({
      decided_plans: [
        { seq: 1, summary: 'a', decision: 'approved', executed: true, steps_succeeded: 2, steps_failed: 0 },
        { seq: 3, summary: 'b', decision: 'rejected', executed: false, steps_succeeded: 0, steps_failed: 0 },
      ],
      rejected_capabilities: ['grantAccess'],
      applied_change_count: 2,
      last_drift: null,
      last_error: { seq: 9, message: 'boom' },
    })
    expect(text).toContain('2 earlier plan(s) decided (1 approved, 1 rejected)')
    expect(text).toContain('2 change(s) already applied')
    expect(text).toContain('Previously rejected operations')
    expect(text).toContain('grantAccess')
    expect(text).toContain('boom')
  })

  it('surfaces an outstanding verification drift so the planner is told to reconcile it', () => {
    const text = describeFacts({
      decided_plans: [],
      rejected_capabilities: [],
      applied_change_count: 1,
      last_drift: { seq: 4, summary: 'The Billing application is not present.' },
      last_error: null,
    })
    expect(text).toContain('Most recent post-apply verification reported drift')
    expect(text).toContain('The Billing application is not present.')
  })
})
