// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Typed turn-content contract and the deterministic reducer that folds the Operator turn ledger into working memory.

import { z } from 'zod'

const TEXT_MAX = 16_000
const SUMMARY_MAX = 2_000
const STEP_MAX = 50
const IdString = z.string().regex(/^[A-Za-z0-9_.\-:]{1,128}$/)

export const TURN_KINDS = ['message', 'plan', 'approval', 'rejection', 'execution', 'error', 'note'] as const

export type TurnKind = (typeof TURN_KINDS)[number]

const MessageContent = z.object({ text: z.string().min(1).max(TEXT_MAX) }).strict()

const PlanStep = z
  .object({
    id: IdString,
    capability: z.string().min(1).max(SUMMARY_MAX),
    summary: z.string().min(1).max(SUMMARY_MAX),
    mutating: z.boolean(),
    // The catalog-normalized arguments, retained so an approved plan can be replayed
    // at execution time without re-deriving intent. Never contains secrets.
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()

const PlanContent = z
  .object({
    summary: z.string().min(1).max(SUMMARY_MAX),
    steps: z.array(PlanStep).min(1).max(STEP_MAX),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seen = new Set<string>()
    for (const step of plan.steps) {
      if (seen.has(step.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate step id '${step.id}'`, path: ['steps'] })
      }
      seen.add(step.id)
    }
  })

const ApprovalContent = z.object({ plan_seq: z.number().int().min(1) }).strict()

const RejectionContent = z.object({ plan_seq: z.number().int().min(1), reason: z.string().min(1).max(SUMMARY_MAX).optional() }).strict()

const ExecutionContent = z
  .object({
    plan_seq: z.number().int().min(1),
    step_id: IdString,
    status: z.enum(['succeeded', 'failed']),
    detail: z.string().min(1).max(SUMMARY_MAX).optional(),
    executed_by: IdString.optional(),
  })
  .strict()

const ErrorContent = z.object({ message: z.string().min(1).max(SUMMARY_MAX) }).strict()

const NoteContent = z.object({ text: z.string().min(1).max(TEXT_MAX), reasoning: z.string().min(1).max(TEXT_MAX).optional() }).strict()

const CONTENT_SCHEMAS: Record<TurnKind, z.ZodType<Record<string, unknown>>> = {
  message: MessageContent,
  plan: PlanContent,
  approval: ApprovalContent,
  rejection: RejectionContent,
  execution: ExecutionContent,
  error: ErrorContent,
  note: NoteContent,
}

export function parseTurnContent(kind: TurnKind, content: unknown): { ok: true; content: Record<string, unknown> } | { ok: false } {
  const parsed = CONTENT_SCHEMAS[kind].safeParse(content)
  return parsed.success ? { ok: true, content: parsed.data } : { ok: false }
}

// Minimal row shape the reducer needs; the route maps ledger rows onto it.
export interface TurnRecord {
  seq: number
  role: 'user' | 'operator' | 'system'
  kind: TurnKind
  content: Record<string, unknown>
}

export type PlanDecision = 'pending' | 'approved' | 'rejected'

export interface StepState {
  id: string
  capability: string
  summary: string
  mutating: boolean
  status: 'pending' | 'succeeded' | 'failed'
  detail?: string
}

export interface PlanState {
  seq: number
  summary: string
  decision: PlanDecision
  decision_seq: number | null
  rejection_reason: string | null
  steps: StepState[]
  progress: { total: number; succeeded: number; failed: number; pending: number }
}

export interface RecentMessage {
  seq: number
  role: 'user' | 'operator' | 'system'
  text: string
}

export interface ConversationState {
  latest_plan: PlanState | null
  pending_approval: boolean
  recent_messages: RecentMessage[]
  last_error: { seq: number; message: string } | null
}

export interface DeriveOptions {
  messageWindow?: number
}

const DEFAULT_MESSAGE_WINDOW = 10

// Folds an ascending-seq turn slice into a working-memory snapshot. The slice
// must contain the latest plan turn and every turn after it so plan decisions and
// execution results resolve correctly; messages outside the window are summarized
// down to the most recent few.
export function deriveConversationState(turns: TurnRecord[], options: DeriveOptions = {}): ConversationState {
  const ordered = [...turns].sort((a, b) => a.seq - b.seq)
  const messageWindow = Math.max(1, options.messageWindow ?? DEFAULT_MESSAGE_WINDOW)

  let latestPlanTurn: TurnRecord | null = null
  for (const turn of ordered) {
    if (turn.kind === 'plan') latestPlanTurn = turn
  }

  let lastError: ConversationState['last_error'] = null
  for (const turn of ordered) {
    if (turn.kind === 'error') {
      lastError = { seq: turn.seq, message: String(turn.content.message ?? '') }
    }
  }

  const recent: RecentMessage[] = []
  for (let i = ordered.length - 1; i >= 0 && recent.length < messageWindow; i--) {
    const turn = ordered[i]
    if (turn.kind === 'message') {
      recent.push({ seq: turn.seq, role: turn.role, text: String(turn.content.text ?? '') })
    }
  }
  recent.reverse()

  const latestPlan = latestPlanTurn ? derivePlanState(latestPlanTurn, ordered) : null

  return {
    latest_plan: latestPlan,
    pending_approval: latestPlan ? latestPlan.decision === 'pending' : false,
    recent_messages: recent,
    last_error: lastError,
  }
}

function derivePlanState(planTurn: TurnRecord, ordered: TurnRecord[]): PlanState {
  const plan = planTurn.content as unknown as {
    summary: string
    steps: { id: string; capability: string; summary: string; mutating: boolean }[]
  }

  let decision: PlanDecision = 'pending'
  let decisionSeq: number | null = null
  let rejectionReason: string | null = null
  const stepStatus = new Map<string, { status: 'succeeded' | 'failed'; detail?: string }>()

  for (const turn of ordered) {
    if (turn.seq <= planTurn.seq) continue
    if (turn.kind === 'approval' && turn.content.plan_seq === planTurn.seq) {
      decision = 'approved'
      decisionSeq = turn.seq
      rejectionReason = null
    } else if (turn.kind === 'rejection' && turn.content.plan_seq === planTurn.seq) {
      decision = 'rejected'
      decisionSeq = turn.seq
      rejectionReason = typeof turn.content.reason === 'string' ? turn.content.reason : null
    } else if (turn.kind === 'execution' && turn.content.plan_seq === planTurn.seq) {
      const stepId = String(turn.content.step_id ?? '')
      const status = turn.content.status === 'failed' ? 'failed' : 'succeeded'
      const detail = typeof turn.content.detail === 'string' ? turn.content.detail : undefined
      stepStatus.set(stepId, { status, detail })
    }
  }

  const steps: StepState[] = plan.steps.map((step) => {
    const exec = stepStatus.get(step.id)
    return {
      id: step.id,
      capability: step.capability,
      summary: step.summary,
      mutating: step.mutating,
      status: exec?.status ?? 'pending',
      ...(exec?.detail ? { detail: exec.detail } : {}),
    }
  })

  const succeeded = steps.filter((s) => s.status === 'succeeded').length
  const failed = steps.filter((s) => s.status === 'failed').length

  return {
    seq: planTurn.seq,
    summary: plan.summary,
    decision,
    decision_seq: decisionSeq,
    rejection_reason: rejectionReason,
    steps,
    progress: {
      total: steps.length,
      succeeded,
      failed,
      pending: steps.length - succeeded - failed,
    },
  }
}
