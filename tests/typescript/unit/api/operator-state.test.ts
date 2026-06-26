// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator turn-content contract and the deterministic working-memory reducer.

import { describe, it, expect } from 'vitest'
import { parseTurnContent, deriveConversationState, type TurnRecord } from '../../../../apps/api/src/operator-state.js'

describe('parseTurnContent', () => {
  it('accepts a well-formed message', () => {
    expect(parseTurnContent('message', { text: 'hello' })).toEqual({ ok: true, content: { text: 'hello' } })
  })

  it('rejects a message with no text', () => {
    expect(parseTurnContent('message', {})).toEqual({ ok: false })
  })

  it('rejects unknown fields on a strict schema', () => {
    expect(parseTurnContent('message', { text: 'hi', extra: 1 })).toEqual({ ok: false })
  })

  it('accepts a plan with unique step ids', () => {
    const content = { summary: 'do it', steps: [{ id: 's1', capability: 'c', summary: 's', mutating: false }] }
    expect(parseTurnContent('plan', content).ok).toBe(true)
  })

  it('rejects a plan with duplicate step ids', () => {
    const content = {
      summary: 'do it',
      steps: [
        { id: 's1', capability: 'c', summary: 's', mutating: false },
        { id: 's1', capability: 'c2', summary: 's2', mutating: true },
      ],
    }
    expect(parseTurnContent('plan', content)).toEqual({ ok: false })
  })

  it('rejects a plan with no steps', () => {
    expect(parseTurnContent('plan', { summary: 'x', steps: [] })).toEqual({ ok: false })
  })

  it('validates approval and execution references', () => {
    expect(parseTurnContent('approval', { plan_seq: 2 }).ok).toBe(true)
    expect(parseTurnContent('execution', { plan_seq: 2, step_id: 's1', status: 'succeeded' }).ok).toBe(true)
    expect(parseTurnContent('execution', { plan_seq: 2, step_id: 's1', status: 'bogus' }).ok).toBe(false)
  })
})

function plan(seq: number): TurnRecord {
  return {
    seq,
    role: 'operator',
    kind: 'plan',
    content: {
      summary: `plan-${seq}`,
      steps: [
        { id: 's1', capability: 'connectProvider', summary: 'bind', mutating: true },
        { id: 's2', capability: 'grantAccess', summary: 'grant', mutating: true },
      ],
    },
  }
}

describe('deriveConversationState', () => {
  it('returns an empty snapshot for no turns', () => {
    expect(deriveConversationState([])).toEqual({
      latest_plan: null,
      pending_approval: false,
      recent_messages: [],
      last_error: null,
    })
  })

  it('marks a plan with no decision as pending approval', () => {
    const state = deriveConversationState([{ seq: 1, role: 'user', kind: 'message', content: { text: 'go' } }, plan(2)])
    expect(state.pending_approval).toBe(true)
    expect(state.latest_plan).toMatchObject({ seq: 2, decision: 'pending' })
    expect(state.latest_plan?.progress).toEqual({ total: 2, succeeded: 0, failed: 0, pending: 2 })
  })

  it('resolves approval and partial execution', () => {
    const state = deriveConversationState([
      plan(2),
      { seq: 3, role: 'user', kind: 'approval', content: { plan_seq: 2 } },
      { seq: 4, role: 'operator', kind: 'execution', content: { plan_seq: 2, step_id: 's1', status: 'succeeded' } },
      { seq: 5, role: 'operator', kind: 'execution', content: { plan_seq: 2, step_id: 's2', status: 'failed', detail: 'denied' } },
    ])
    expect(state.pending_approval).toBe(false)
    expect(state.latest_plan).toMatchObject({ decision: 'approved', decision_seq: 3 })
    expect(state.latest_plan?.progress).toEqual({ total: 2, succeeded: 1, failed: 1, pending: 0 })
    expect(state.latest_plan?.steps.find((s) => s.id === 's2')).toMatchObject({ status: 'failed', detail: 'denied' })
  })

  it('records rejection with reason', () => {
    const state = deriveConversationState([
      plan(2),
      { seq: 3, role: 'user', kind: 'rejection', content: { plan_seq: 2, reason: 'too broad' } },
    ])
    expect(state.latest_plan).toMatchObject({ decision: 'rejected', rejection_reason: 'too broad' })
  })

  it('only tracks the latest plan and ignores decisions for superseded plans', () => {
    const state = deriveConversationState([plan(2), { seq: 3, role: 'user', kind: 'approval', content: { plan_seq: 2 } }, plan(4)])
    expect(state.latest_plan?.seq).toBe(4)
    expect(state.latest_plan?.decision).toBe('pending')
  })

  it('keeps only the most recent messages within the window', () => {
    const turns: TurnRecord[] = []
    for (let i = 1; i <= 5; i++) {
      turns.push({ seq: i, role: 'user', kind: 'message', content: { text: `m${i}` } })
    }
    const state = deriveConversationState(turns, { messageWindow: 2 })
    expect(state.recent_messages).toEqual([
      { seq: 4, role: 'user', text: 'm4' },
      { seq: 5, role: 'user', text: 'm5' },
    ])
  })

  it('surfaces the most recent error', () => {
    const state = deriveConversationState([
      { seq: 1, role: 'system', kind: 'error', content: { message: 'first' } },
      { seq: 2, role: 'system', kind: 'error', content: { message: 'second' } },
    ])
    expect(state.last_error).toEqual({ seq: 2, message: 'second' })
  })

  it('folds turns regardless of input ordering', () => {
    const state = deriveConversationState([{ seq: 3, role: 'user', kind: 'approval', content: { plan_seq: 2 } }, plan(2)])
    expect(state.latest_plan).toMatchObject({ seq: 2, decision: 'approved' })
  })
})
