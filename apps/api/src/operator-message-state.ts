// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Operator message run state machine for durable chat lifecycle transitions.

export const MESSAGE_RUN_STATES = [
  'queued',
  'sending',
  'waiting_for_model',
  'reasoning',
  'waiting_for_tool',
  'waiting_for_user_approval',
  'executing',
  'streaming',
  'completed',
  'cancelled',
  'failed',
  'timeout',
] as const

export type MessageRunState = (typeof MESSAGE_RUN_STATES)[number]

export const TERMINAL_MESSAGE_RUN_STATES = ['completed', 'cancelled', 'failed', 'timeout'] as const satisfies readonly MessageRunState[]

type TerminalMessageRunState = (typeof TERMINAL_MESSAGE_RUN_STATES)[number]

const TERMINAL_STATES = new Set<MessageRunState>(TERMINAL_MESSAGE_RUN_STATES)

const TRANSITIONS: Record<MessageRunState, readonly MessageRunState[]> = {
  queued: ['sending', 'cancelled', 'failed', 'timeout'],
  sending: ['waiting_for_model', 'cancelled', 'failed', 'timeout'],
  waiting_for_model: ['reasoning', 'waiting_for_tool', 'waiting_for_user_approval', 'streaming', 'completed', 'cancelled', 'failed', 'timeout'],
  reasoning: ['waiting_for_tool', 'streaming', 'completed', 'cancelled', 'failed', 'timeout'],
  waiting_for_tool: ['executing', 'waiting_for_user_approval', 'cancelled', 'failed', 'timeout'],
  waiting_for_user_approval: ['executing', 'cancelled', 'failed', 'timeout'],
  executing: ['waiting_for_tool', 'streaming', 'completed', 'cancelled', 'failed', 'timeout'],
  streaming: ['waiting_for_tool', 'completed', 'cancelled', 'failed', 'timeout'],
  completed: [],
  cancelled: [],
  failed: [],
  timeout: [],
}

export interface MessageRunSnapshot {
  id: string
  state: MessageRunState
  lastEventSeq: number
  reason: string | null
  errorCode: string | null
  errorDetail: string | null
  completedAt: string | null
}

export interface MessageRunEvent {
  eventSeq: number
  state: MessageRunState
  reason?: string | null
  errorCode?: string | null
  errorDetail?: string | null
  createdAt?: string | null
}

export class InvalidMessageRunTransitionError extends Error {
  constructor(
    readonly from: MessageRunState,
    readonly to: MessageRunState,
  ) {
    super(`invalid message run transition ${from} -> ${to}`)
    this.name = 'InvalidMessageRunTransitionError'
  }
}

export class InvalidMessageRunEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMessageRunEventError'
  }
}

export function isTerminalMessageRunState(state: MessageRunState): state is TerminalMessageRunState {
  return TERMINAL_STATES.has(state)
}

export function canTransitionMessageRun(from: MessageRunState, to: MessageRunState): boolean {
  return from === to || TRANSITIONS[from].includes(to)
}

export function assertMessageRunTransition(from: MessageRunState, to: MessageRunState): void {
  if (!canTransitionMessageRun(from, to)) throw new InvalidMessageRunTransitionError(from, to)
}

export function applyMessageRunEvent(run: MessageRunSnapshot, event: MessageRunEvent): MessageRunSnapshot {
  if (!Number.isInteger(event.eventSeq) || event.eventSeq <= run.lastEventSeq) {
    throw new InvalidMessageRunEventError('message run events must advance monotonically')
  }
  assertMessageRunTransition(run.state, event.state)
  const terminal = isTerminalMessageRunState(event.state)
  return {
    ...run,
    state: event.state,
    lastEventSeq: event.eventSeq,
    reason: event.reason ?? run.reason,
    errorCode: event.errorCode ?? run.errorCode,
    errorDetail: event.errorDetail ?? run.errorDetail,
    completedAt: terminal ? (event.createdAt ?? run.completedAt) : run.completedAt,
  }
}

export function foldMessageRunEvents(run: MessageRunSnapshot, events: readonly MessageRunEvent[]): MessageRunSnapshot {
  return [...events].sort((left, right) => left.eventSeq - right.eventSeq).reduce(applyMessageRunEvent, run)
}