// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator message run finite state machine.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  InvalidMessageRunEventError,
  InvalidMessageRunTransitionError,
  MESSAGE_RUN_STATES,
  applyMessageRunEvent,
  assertMessageRunTransition,
  canTransitionMessageRun,
  foldMessageRunEvents,
  isTerminalMessageRunState,
  type MessageRunSnapshot,
} from '../../../../apps/api/src/operator-message-state.js'

function run(state: MessageRunSnapshot['state'] = 'queued'): MessageRunSnapshot {
  return {
    id: 'run-1',
    state,
    lastEventSeq: 0,
    reason: null,
    errorCode: null,
    errorDetail: null,
    completedAt: null,
  }
}

describe('operator message run transitions', () => {
  it('allows the normal answer lifecycle', () => {
    const completed = foldMessageRunEvents(run(), [
      { eventSeq: 1, state: 'sending', reason: 'accepted' },
      { eventSeq: 2, state: 'waiting_for_model' },
      { eventSeq: 3, state: 'reasoning' },
      { eventSeq: 4, state: 'streaming' },
      { eventSeq: 5, state: 'completed', createdAt: '2026-07-01T00:00:00Z' },
    ])
    expect(completed).toMatchObject({ state: 'completed', lastEventSeq: 5, completedAt: '2026-07-01T00:00:00Z' })
  })

  it('allows approval-gated execution after tool planning', () => {
    const completed = foldMessageRunEvents(run(), [
      { eventSeq: 1, state: 'sending' },
      { eventSeq: 2, state: 'waiting_for_model' },
      { eventSeq: 3, state: 'waiting_for_tool' },
      { eventSeq: 4, state: 'waiting_for_user_approval' },
      { eventSeq: 5, state: 'executing' },
      { eventSeq: 6, state: 'completed' },
    ])
    expect(completed.state).toBe('completed')
  })

  it('allows a plan response to stop at approval without pretending the work completed', () => {
    const waiting = foldMessageRunEvents(run(), [
      { eventSeq: 1, state: 'sending' },
      { eventSeq: 2, state: 'waiting_for_model' },
      { eventSeq: 3, state: 'waiting_for_user_approval', reason: 'approval_required' },
    ])
    expect(waiting).toMatchObject({ state: 'waiting_for_user_approval', completedAt: null, reason: 'approval_required' })
  })

  it('rejects transitions out of terminal states', () => {
    expect(() => assertMessageRunTransition('completed', 'streaming')).toThrow(InvalidMessageRunTransitionError)
    expect(canTransitionMessageRun('failed', 'sending')).toBe(false)
  })

  it('treats repeated state application as idempotent while event sequence advances', () => {
    const waiting = applyMessageRunEvent(run('waiting_for_model'), { eventSeq: 1, state: 'waiting_for_model' })
    expect(waiting).toMatchObject({ state: 'waiting_for_model', lastEventSeq: 1 })
  })

  it('rejects stale or duplicate events', () => {
    const current = { ...run('sending'), lastEventSeq: 3 }
    expect(() => applyMessageRunEvent(current, { eventSeq: 3, state: 'waiting_for_model' })).toThrow(InvalidMessageRunEventError)
  })

  it('records explicit terminal failures without claiming success', () => {
    const failed = applyMessageRunEvent(run('waiting_for_model'), {
      eventSeq: 1,
      state: 'failed',
      errorCode: 'ai_unavailable',
      errorDetail: 'No model provider is available.',
    })
    expect(failed).toMatchObject({ state: 'failed', errorCode: 'ai_unavailable', completedAt: null })
    expect(isTerminalMessageRunState(failed.state)).toBe(true)
  })

  it('keeps the PostgreSQL state constraint aligned with the TypeScript vocabulary', () => {
    const migration = readFileSync(new URL('../../../../infra/postgres/migrations/0014_operator_message_runs.up.sql', import.meta.url), 'utf8')
    for (const state of MESSAGE_RUN_STATES) {
      expect(migration).toContain(`'${state}'::text`)
    }
  })
})