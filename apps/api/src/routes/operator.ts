// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Operator Control API: the authoritative conversation ledger backing Caracal Operator.

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { withTransaction, TxAbort, type TxClient, type DB } from '../db.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'
import { parseTurnContent, deriveConversationState, type TurnKind, type TurnRecord } from '../operator-state.js'
import {
  CAPABILITIES,
  ProposedPlan,
  listCapabilities,
  validateProposedPlan,
  type CapabilityDomain,
  type PlanValidation,
} from '../operator-capabilities.js'
import { previewPlan, type StepPreview } from '../operator-preview.js'
import { buildOperatorAuthority, isZoneIsolated, authorizePlanSteps, type OperatorAuthority } from '../operator-authority.js'
import { buildOperatorControlClient, type OperatorControlEndpoints } from '../operator-control-client.js'
import { executeViaControlPlane, type GovernedPlanStep } from '../operator-governed-execute.js'
import { createRoleScopedClient, roleScopes } from '../operator-agent-roles.js'
import { isControlExecutable } from '../operator-control-map.js'
import { SYSTEM_ZONE_SLUG } from '../system-zone.js'
import { mayAutoApprove, autopilotAvailable, buildAutopilotPolicy, type AutopilotPolicy } from '../operator-autopilot.js'
import type { ControlClient } from '../control-client.js'
import type { OperatorControlIdentity } from '../config.js'
import {
  createGateway,
  withUsage,
  preferProvider,
  GatewayUnavailableError,
  GatewayError,
  GatewayBudgetError,
  type Gateway,
  type ProviderConfig,
} from '../operator-gateway.js'
import { type GovernanceLimits } from '../operator-ai-governance.js'
import { runVerifier, type AgentContext, type OperatorMode, type SecurityAdvisory, type PolicyDraft } from '../operator-agents.js'
import { recallZoneMemory, rememberAppliedChange } from '../operator-zone-memory.js'
import { createOrchestrator, type OnProgress, type ProgressEvent } from '../operator-orchestrator.js'
import { createStateResearcher } from '../operator-research.js'
import { retrieveDocs } from '../operator-docs.js'
import { summarizeHistory, type ConversationFacts } from '../operator-memory.js'
import { OperatorAiNotFoundError, OperatorAiUnavailableError, type OperatorAiManager } from '../operator-ai-manager.js'
import { PROVIDER_SLUG_PATTERN } from '../operator-ai-store.js'
import { assertMessageRunTransition, type MessageRunState } from '../operator-message-state.js'

const TITLE_MAX_LENGTH = 200
const CONTENT_MAX_BYTES = 64_000
const DEFAULT_TURN_PAGE = 200
const MAX_TURN_PAGE = 500

// number is a bigint column, which the driver would otherwise hand back as a string. The
// console types it as a number and matches it with strict equality when restoring the open
// conversation, so it is cast to int here: the per-zone counter never approaches the int
// ceiling, and the honest numeric type keeps those comparisons from silently failing.
const CONVERSATION_SELECT = 'id, zone_id, number::int AS number, title, status, mode, autopilot, created_by, created_at, updated_at, last_activity_at, archived_at'
// seq is a bigint column, which the driver would otherwise hand back as a string. The turn
// contract types seq as a number and callers send it straight back as plan_seq, so it is cast
// to int here: a per-conversation gapless counter never approaches the int ceiling, and the
// honest numeric type keeps the approval and execution bodies from rejecting a stringified seq.
const TURN_SELECT = 'id, conversation_id, seq::int AS seq, role, kind, content, actor_id, created_at'
const MESSAGE_RUN_SELECT =
  'id, zone_id, conversation_id, client_message_id, server_message_turn_id, correlation_id, state, actor_id, provider_id, reason, error_code, error_detail, deadline_at, started_at, updated_at, completed_at, last_event_seq::int AS last_event_seq'

const CreateConversationBody = z
  .object({
    title: z.string().min(1).max(TITLE_MAX_LENGTH),
    mode: z.enum(['ask', 'agent']).optional(),
    autopilot: z.boolean().optional(),
  })
  .strict()

const PatchConversationBody = z
  .object({
    title: z.string().min(1).max(TITLE_MAX_LENGTH).optional(),
    status: z.enum(['active', 'archived']).optional(),
    mode: z.enum(['ask', 'agent']).optional(),
    autopilot: z.boolean().optional(),
  })
  .strict()

// Free-form narrative kinds the caller may append directly. Governed kinds — plan,
// approval, rejection, execution — are written only through the lifecycle endpoints
// so they cannot enter the ledger without catalog and referential integrity checks.
const NARRATIVE_TURN_KINDS = ['message', 'note', 'error'] as const

const AppendTurnBody = z
  .object({
    role: z.enum(['user', 'operator', 'system']),
    kind: z.enum(NARRATIVE_TURN_KINDS),
    content: z.unknown(),
    client_token: z
      .string()
      .regex(/^[A-Za-z0-9_.\-:]{1,128}$/)
      .optional(),
  })
  .strict()

const PlanDecisionBody = z
  .object({
    plan_seq: z.coerce.number().int().min(1),
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict()

const ExecutePlanBody = z.object({ plan_seq: z.coerce.number().int().min(1) }).strict()

// One in-flight governed execution per plan. Each step is its own authenticated control
// call rather than one database transaction, so the conversation row cannot serialize
// concurrent executes; a short-lived Redis lock does. The TTL only bounds a crashed
// request — a handful of fast control calls complete well within it — while the permanent
// dedup (an execution turn already exists) prevents re-running a completed plan.
const EXECUTE_LOCK_TTL_SEC = 120

// The outcome of the read-only execute pre-flight: the validated steps to apply, or a
// business response to return unchanged. Pre-flight writes nothing, so the governed
// control calls run outside any transaction.
type PreflightResult =
  { ok: true; summary: string; steps: GovernedPlanStep[] } | { ok: false; status: number; body: Record<string, unknown> }

const MESSAGE_MAX_LENGTH = 4000
const MESSAGE_RUN_DEADLINE_MS = 120_000
const MessageRunId = z.string().regex(/^[A-Za-z0-9_.\-:]{1,128}$/)
const MessageBody = z
  .object({
    message: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
    // Optional id of the configured provider to answer with. When omitted, the gateway's
    // failover order chooses. Switching it mid-conversation only routes the next message;
    // the conversation history the agents reason over is unchanged.
    provider: z.string().min(1).max(64).optional(),
    client_message_id: MessageRunId.optional(),
    correlation_id: MessageRunId.optional(),
  })
  .strict()
const MESSAGE_CONTEXT_WINDOW = 10

// The response headers that open a Server-Sent Events stream for a message turn. no-transform
// keeps a proxy from buffering the stream, so stage events reach the client as they happen.
const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const

// How often a comment frame is written while a turn is deliberating. A model call runs without
// emitting any frame, so on a cold or slow model the gap between two stages can outlast a proxy's
// inactivity deadline and the stream is cut mid-turn. A periodic keepalive keeps bytes flowing so
// a legitimately slow deliberation is never mistaken for a stalled connection; the interval sits
// well under the console proxy's inactivity window so a healthy stream always stays open.
const SSE_HEARTBEAT_MS = 15_000

// Writes one Server-Sent Event frame to the hijacked response. The route owns the event names:
// stage (a progress signal), reasoning (a delta of the model's chain of thought as it thinks),
// token (a text delta of the answer as it is produced), result (the authoritative success body),
// and error (a governance or gateway stop). The terminal frame carries the exact body the
// non-streaming path would return, so streaming changes only delivery timing, never the decided
// outcome.
function writeSseEvent(reply: FastifyReply, event: 'stage' | 'reasoning' | 'token' | 'result' | 'error', data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

interface PlanTurnContent {
  summary: string
  steps: { id: string; capability: string; args?: Record<string, unknown> }[]
}

const ContextQuery = z.object({
  message_window: z.coerce.number().int().min(1).max(50).default(10),
})

const TurnQuery = z.object({
  after_seq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_TURN_PAGE).default(DEFAULT_TURN_PAGE),
})

const ListSearchQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
})

// Neutralizes LIKE/ILIKE metacharacters so a search term is matched literally.
// Backslash is escaped first so it cannot re-introduce an escape sequence.
function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

// Appends a turn inside an open transaction whose conversation row is already locked
// FOR UPDATE and confirmed active. Allocates the gapless seq and bumps activity. The
// single place turns are written, shared by the narrative and governed endpoints.
async function writeTurnLocked(
  client: TxClient,
  input: {
    conversationId: string
    zoneId: string
    seq: number
    role: string
    kind: TurnKind
    contentJson: string
    actorId: string
    clientToken?: string | null
  },
): Promise<Record<string, unknown>> {
  await client.query(
    `UPDATE operator_conversations
     SET next_seq = next_seq + 1, updated_at = now(), last_activity_at = now()
     WHERE id = $1 AND zone_id = $2`,
    [input.conversationId, input.zoneId],
  )
  const { rows } = await client.query(
    `INSERT INTO operator_turns
       (id, conversation_id, zone_id, seq, role, kind, content, actor_id, client_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     RETURNING ${TURN_SELECT}`,
    [
      uuidv7(),
      input.conversationId,
      input.zoneId,
      input.seq,
      input.role,
      input.kind,
      input.contentJson,
      input.actorId,
      input.clientToken ?? null,
    ],
  )
  return rows[0] as Record<string, unknown>
}

interface MessageRunRow {
  id: string
  zone_id: string
  conversation_id: string
  client_message_id: string
  server_message_turn_id: string | null
  correlation_id: string
  state: MessageRunState
  actor_id: string | null
  provider_id: string | null
  reason: string | null
  error_code: string | null
  error_detail: string | null
  deadline_at: string | null
  started_at: string
  updated_at: string
  completed_at: string | null
  last_event_seq: number
}

interface PublicMessageRun {
  id: string
  client_message_id: string
  correlation_id: string
  state: MessageRunState
  reason: string | null
  error_code: string | null
  error_detail: string | null
  deadline_at: string | null
  completed_at: string | null
  last_event_seq: number
}

function publicMessageRun(run: MessageRunRow): PublicMessageRun {
  return {
    id: run.id,
    client_message_id: run.client_message_id,
    correlation_id: run.correlation_id,
    state: run.state,
    reason: run.reason,
    error_code: run.error_code,
    error_detail: run.error_detail,
    deadline_at: run.deadline_at,
    completed_at: run.completed_at,
    last_event_seq: run.last_event_seq,
  }
}

async function writeMessageRunEventLocked(
  client: TxClient,
  input: {
    run: MessageRunRow
    state: MessageRunState
    reason?: string | null
    errorCode?: string | null
    errorDetail?: string | null
    payload?: Record<string, unknown>
  },
): Promise<MessageRunRow> {
  assertMessageRunTransition(input.run.state, input.state)
  const eventSeq = input.run.last_event_seq + 1
  await client.query(
    `INSERT INTO operator_message_run_events
       (id, run_id, zone_id, conversation_id, event_seq, state, reason, error_code, error_detail, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      uuidv7(),
      input.run.id,
      input.run.zone_id,
      input.run.conversation_id,
      eventSeq,
      input.state,
      input.reason ?? null,
      input.errorCode ?? null,
      input.errorDetail ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  )
  const terminal = ['completed', 'cancelled', 'failed', 'timeout'].includes(input.state)
  const { rows } = await client.query<MessageRunRow>(
    `UPDATE operator_message_runs
     SET state = $2,
         reason = COALESCE($3, reason),
         error_code = COALESCE($4, error_code),
         error_detail = COALESCE($5, error_detail),
         completed_at = CASE WHEN $6 THEN COALESCE(completed_at, now()) ELSE completed_at END,
         last_event_seq = $7,
         updated_at = now()
     WHERE id = $1
     RETURNING ${MESSAGE_RUN_SELECT}`,
    [input.run.id, input.state, input.reason ?? null, input.errorCode ?? null, input.errorDetail ?? null, terminal, eventSeq],
  )
  return rows[0]
}

type MessageRunStartOutcome =
  | { ok: true; duplicate: false; run: MessageRunRow; turn: Record<string, unknown>; mode: OperatorMode; autopilot: boolean }
  | { ok: true; duplicate: true; run: MessageRunRow; mode: OperatorMode; autopilot: boolean }
  | { ok: false; status: number; body: Record<string, unknown> }

async function startMessageRunTx(
  db: DB,
  input: {
    conversationId: string
    zoneId: string
    message: string
    actorId: string
    clientMessageId: string
    correlationId: string
    providerId?: string | null
  },
): Promise<MessageRunStartOutcome> {
  return withTransaction(db, async (client): Promise<MessageRunStartOutcome> => {
    const { rows: conv } = await client.query<{ status: string; mode: string; autopilot: boolean; next_seq: number }>(
      `SELECT status, mode, autopilot, next_seq FROM operator_conversations
       WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
      [input.conversationId, input.zoneId],
    )
    if (!conv[0]) return { ok: false, status: 404, body: { error: 'conversation_not_found' } }
    if (conv[0].status !== 'active') return { ok: false, status: 409, body: { error: 'conversation_archived' } }

    const { rows: existing } = await client.query<MessageRunRow>(
      `SELECT ${MESSAGE_RUN_SELECT} FROM operator_message_runs
       WHERE conversation_id = $1 AND client_message_id = $2
       FOR UPDATE`,
      [input.conversationId, input.clientMessageId],
    )
    if (existing[0]) {
      return {
        ok: true,
        duplicate: true,
        run: existing[0],
        mode: conv[0].mode === 'ask' ? 'ask' : 'agent',
        autopilot: conv[0].autopilot === true,
      }
    }

    const runId = uuidv7()
    const deadlineAt = new Date(Date.now() + MESSAGE_RUN_DEADLINE_MS).toISOString()
    const { rows: runs } = await client.query<MessageRunRow>(
      `INSERT INTO operator_message_runs
         (id, zone_id, conversation_id, client_message_id, correlation_id, state, actor_id, provider_id, deadline_at, last_event_seq)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, 0)
       RETURNING ${MESSAGE_RUN_SELECT}`,
      [runId, input.zoneId, input.conversationId, input.clientMessageId, input.correlationId, input.actorId, input.providerId ?? null, deadlineAt],
    )
    let run = await writeMessageRunEventLocked(client, { run: runs[0], state: 'queued', reason: 'accepted' })
    const turn = await writeTurnLocked(client, {
      conversationId: input.conversationId,
      zoneId: input.zoneId,
      seq: conv[0].next_seq,
      role: 'user',
      kind: 'message',
      contentJson: JSON.stringify({ text: input.message }),
      actorId: input.actorId,
      clientToken: input.clientMessageId,
    })
    const { rows: linked } = await client.query<MessageRunRow>(
      `UPDATE operator_message_runs
       SET server_message_turn_id = $2, updated_at = now()
       WHERE id = $1
       RETURNING ${MESSAGE_RUN_SELECT}`,
      [run.id, turn.id],
    )
    run = await writeMessageRunEventLocked(client, { run: linked[0], state: 'sending', reason: 'message_recorded' })
    return {
      ok: true,
      duplicate: false,
      run,
      turn,
      mode: conv[0].mode === 'ask' ? 'ask' : 'agent',
      autopilot: conv[0].autopilot === true,
    }
  })
}

async function transitionMessageRun(
  db: DB,
  run: MessageRunRow | null,
  state: MessageRunState,
  options: { reason?: string | null; errorCode?: string | null; errorDetail?: string | null; payload?: Record<string, unknown> } = {},
): Promise<MessageRunRow | null> {
  if (!run) return null
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<MessageRunRow>(`SELECT ${MESSAGE_RUN_SELECT} FROM operator_message_runs WHERE id = $1 FOR UPDATE`, [run.id])
    if (!rows[0]) return null
    return writeMessageRunEventLocked(client, {
      run: rows[0],
      state,
      reason: options.reason,
      errorCode: options.errorCode,
      errorDetail: options.errorDetail,
      payload: options.payload,
    })
  })
}

// Renders an authored policy draft as readable Markdown for the conversation ledger, so a console
// that does not yet render the structured policy view still shows the summary, each validated data
// document, its explanation, the risks and recommendations found, and the activation readiness. The
// structured draft is persisted alongside this text so the rich view reads the draft directly; this
// rendering is the narrative record, never the source of truth.
function renderPolicyDraftText(draft: PolicyDraft): string {
  const parts: string[] = [draft.summary]
  if (draft.clarifications.length > 0) {
    parts.push(['Before I can author this safely I need:', ...draft.clarifications.map((question) => `- ${question}`)].join('\n'))
  }
  for (const doc of draft.documents) {
    parts.push([`### ${doc.concern} (${doc.filename})`, '```rego', doc.content, '```', doc.explanation].join('\n'))
  }
  if (draft.risks.length > 0) {
    parts.push(['Risks:', ...draft.risks.map((risk) => `- [${risk.severity}] ${risk.note}`)].join('\n'))
  }
  if (draft.recommendations.length > 0) {
    parts.push(['Recommendations:', ...draft.recommendations.map((rec) => `- ${rec}`)].join('\n'))
  }
  if (draft.activation) {
    const blockers =
      draft.activation.blockers.length > 0 ? `\nBlockers:\n${draft.activation.blockers.map((blocker) => `- ${blocker}`).join('\n')}` : ''
    parts.push(`Activation: ${draft.activation.ready ? 'ready' : 'not yet ready'}. ${draft.activation.guidance}${blockers}`)
  }
  parts.push(`_AI-assisted draft (model ${draft.provenance.model}). Create, version, and activate it through the governed policy path._`)
  return parts.join('\n\n')
}

// Builds the catalog-normalized plan content persisted to a plan turn. Each step
// carries its resolved title and the authoritative mutating flag from the catalog,
// so a stored plan can never claim a capability or effect the catalog does not
// grant. Shared by the plan endpoint and the message orchestrator so a plan from
// natural language and a plan from a direct call are stored identically.
function buildPlanContentJson(summary: string, validation: PlanValidation, advisory?: SecurityAdvisory, deliberation?: ProgressEvent['stage'][], preview?: StepPreview[]): string {
  // The preview resolves each step against live state into a concrete effect - create, update,
  // no-op, or blocked. Persisting it per step lets the human review the consequence the plan was
  // previewed to have, not only what it claims to do. Informational only - execution re-previews
  // and re-derives the plan from summary and steps, never from this recorded effect.
  const effects = new Map((preview ?? []).map((step) => [step.id, step.effect]))
  const content: Record<string, unknown> = {
    summary,
    steps: validation.steps.map((step) => {
      const effect = effects.get(step.id)
      return {
        id: step.id,
        capability: step.capability,
        summary: step.title,
        mutating: step.mutating,
        args: step.args,
        // The plan's order and the planner's own consequence assessment are persisted so the human
        // reviews exactly the dependency chain and per-step risk the guardian reasoned over.
        ...(step.depends_on.length > 0 ? { depends_on: step.depends_on } : {}),
        ...(step.risk ? { risk: step.risk } : {}),
        ...(effect ? { effect } : {}),
      }
    }),
  }
  // A composed plan may carry an advisory security review. It is persisted with the plan so the
  // human sees it when deciding and it stays in the audit record; it is informational only and
  // never read as authority — execution re-derives the plan from summary and steps alone.
  if (advisory) content.advisory = advisory
  // The deliberation stages the request passed through, recorded so the human can replay how the
  // plan was reasoned. Informational only — execution re-derives the plan from summary and steps.
  if (deliberation && deliberation.length > 0) content.deliberation = deliberation
  return JSON.stringify(content)
}

// Bounds the context reducer's working set: the latest plan plus its decision and
// execution turns, capped so a single conversation cannot force an unbounded read.
const PLAN_WINDOW_LIMIT = 200

interface ContextQueryable {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

// Assembles the working-memory snapshot from bounded reads: the latest plan and the
// decision/execution turns that resolve it, the most recent error, and a window of
// recent messages. Shared by the context endpoint and the message orchestrator so
// an agent reasons over exactly what an operator sees.
async function loadConversationState(db: ContextQueryable, conversationId: string, zoneId: string, messageWindow: number) {
  // The plan slice must first find the latest plan seq, but the error and message reads are
  // independent, so overlap all three instead of serializing the round trips.
  const planSlicePromise = (async () => {
    const { rows: planRows } = await db.query<{ seq: number }>(
      `SELECT seq FROM operator_turns
       WHERE conversation_id = $1 AND zone_id = $2 AND kind = 'plan'
       ORDER BY seq DESC LIMIT 1`,
      [conversationId, zoneId],
    )
    const planSeq = planRows[0]?.seq ?? null
    if (!planSeq) return []
    const { rows } = await db.query<TurnRecord>(
      `SELECT seq, role, kind, content FROM operator_turns
       WHERE conversation_id = $1 AND zone_id = $2 AND seq >= $3
         AND kind IN ('plan', 'approval', 'rejection', 'execution', 'error')
       ORDER BY seq ASC LIMIT $4`,
      [conversationId, zoneId, planSeq, PLAN_WINDOW_LIMIT],
    )
    return rows
  })()

  const errorPromise = db.query<TurnRecord>(
    `SELECT seq, role, kind, content FROM operator_turns
     WHERE conversation_id = $1 AND zone_id = $2 AND kind = 'error'
     ORDER BY seq DESC LIMIT 1`,
    [conversationId, zoneId],
  )

  const messagePromise = db.query<TurnRecord>(
    `SELECT seq, role, kind, content FROM operator_turns
     WHERE conversation_id = $1 AND zone_id = $2 AND kind = 'message'
     ORDER BY seq DESC LIMIT $3`,
    [conversationId, zoneId, messageWindow],
  )

  const [planSlice, { rows: errorRows }, { rows: messageRows }] = await Promise.all([planSlicePromise, errorPromise, messagePromise])

  const merged = new Map<number, TurnRecord>()
  for (const turn of [...planSlice, ...errorRows, ...messageRows]) {
    merged.set(turn.seq, turn)
  }
  return deriveConversationState([...merged.values()], { messageWindow })
}

// Bounds the decision-history read used for fact compression. Plan, decision, and
// execution turns are sparse relative to messages, so a generous cap covers a very
// long session while keeping the read bounded.
const FACTS_TURN_LIMIT = 400

// Loads the compressed memory of a conversation's decided plans and outcomes from a
// bounded read of its sparse decision turns. Shared by the context endpoint and the
// message orchestrator so an agent and the console see the same session facts.
async function loadConversationFacts(db: ContextQueryable, conversationId: string, zoneId: string): Promise<ConversationFacts> {
  const { rows } = await db.query<TurnRecord>(
    `SELECT seq, role, kind, content FROM operator_turns
     WHERE conversation_id = $1 AND zone_id = $2
       AND kind IN ('plan', 'approval', 'rejection', 'execution', 'error', 'note')
     ORDER BY seq DESC LIMIT $3`,
    [conversationId, zoneId, FACTS_TURN_LIMIT],
  )
  return summarizeHistory(rows)
}

type AppendOutcome =
  { ok: true; turn: Record<string, unknown>; mode: OperatorMode; autopilot: boolean } | { ok: false; reason: 'not_found' | 'archived' }

// Appends a single turn in its own transaction: locks the conversation, confirms it
// is active, allocates the gapless seq, and writes. Used by the message orchestrator
// to record the operator's message and the agent's response as distinct, ordered
// turns without holding a transaction open across a model call. Returns the conversation's
// operation mode and autopilot engage flag read under the same lock, so the caller enforces
// ask mode and evaluates autopilot against the exact settings the turn was recorded under,
// with no extra query and no race.
async function appendTurnTx(
  db: DB,
  conversationId: string,
  zoneId: string,
  role: 'user' | 'operator' | 'system',
  kind: TurnKind,
  contentJson: string,
  actorId: string,
): Promise<AppendOutcome> {
  return withTransaction(db, async (client) => {
    const { rows: conv } = await client.query<{ status: string; mode: string; autopilot: boolean; next_seq: number }>(
      `SELECT status, mode, autopilot, next_seq FROM operator_conversations
       WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
      [conversationId, zoneId],
    )
    if (!conv[0]) return { ok: false as const, reason: 'not_found' as const }
    if (conv[0].status !== 'active') return { ok: false as const, reason: 'archived' as const }
    const turn = await writeTurnLocked(client, {
      conversationId,
      zoneId,
      seq: conv[0].next_seq,
      role,
      kind,
      contentJson,
      actorId,
    })
    return { ok: true as const, turn, mode: conv[0].mode === 'ask' ? 'ask' : 'agent', autopilot: conv[0].autopilot === true }
  })
}

export interface OperatorRoutesOptions {
  enabled: boolean
  allowedCapabilities?: string[] | null
  systemZones?: string[] | null
  // Supplies the current AI provider list each time the gateway is built, so a provider added
  // or edited at runtime applies to the next request without an env edit or restart. Defaults
  // to an empty list, which reports the AI tier disabled.
  loadAiProviders?: () => ProviderConfig[]
  // The runtime manager for governed model providers, or null when self-governance cannot seal
  // keys. When null the provider-management routes report the feature unavailable.
  aiManager?: OperatorAiManager | null
  // Internal-only: resolves the Operator's reserved caracal.sys control identity at request
  // time. Returns null until the system zone is provisioned (or when self-governance is
  // disabled), which leaves governed execution unconfigured. A getter rather than a static
  // value because the identity is resolved after the server is listening, when the
  // provisioner can reach the control plane over loopback. Never an end-user surface.
  resolveControlIdentity?: () => OperatorControlIdentity | null
  // The deployment's control endpoints (STS plus the loopback control plane) the Operator's
  // governed client talks to. Null when the control plane is disabled, which leaves governed
  // execution unconfigured.
  controlEndpoints?: OperatorControlEndpoints | null
  // Injectable transport so the gateway path can be exercised in tests without a
  // live AI backend; defaults to the platform fetch in production.
  fetchImpl?: typeof fetch
  // The Caracal-governed autopilot policy: the deployment-set boundary of what may be
  // auto-approved in agent mode. Defaults to a disabled policy that approves nothing, so the
  // routes are safe when no policy is supplied.
  autopilotPolicy?: AutopilotPolicy
  // Caracal-set governance over the Operator's model usage: a per-call output-token ceiling
  // applied uniformly across providers, and a per-turn model-call budget. Optional; when absent
  // the gateway runs without a ceiling and the message turn without a call budget.
  aiGovernance?: GovernanceLimits
}

export const operatorRoutes: FastifyPluginAsync<OperatorRoutesOptions> = async (fastify, opts) => {
  // Resolve the Operator's reserved, least-privilege identity once. A
  // misconfigured grant throws here, so the service fails closed at startup
  // rather than running with an unintended authority.
  const authority: OperatorAuthority = buildOperatorAuthority({
    allowedCapabilities: opts.allowedCapabilities,
    systemZones: opts.systemZones,
  })

  // The autopilot policy, defaulting to a disabled policy that approves nothing when none is
  // supplied. The policy is the Caracal-side boundary of what may be auto-approved; it is read
  // here and never derived from a request, so a conversation can engage autopilot but never widen
  // what autopilot may do.
  const autopilotPolicy: AutopilotPolicy = opts.autopilotPolicy ?? buildAutopilotPolicy()

  // The optional AI gateway, rebuilt per use from the current provider list so a runtime
  // provider change applies to the next request. With no provider configured it reports
  // disabled and performs no work, so the AI tier costs nothing until an operator brings a key.
  // The Caracal governance limits, when supplied, install the output-token ceiling middleware on
  // every call.
  const buildGateway = (): Gateway => createGateway(opts.loadAiProviders?.() ?? [], opts.fetchImpl, opts.aiGovernance)

  // The orchestrator triages each turn to its tier and runs the one skill that handles it,
  // returning a typed artifact the deterministic spine below validates, previews, and governs.
  // Built once for the plugin; it holds no per-request state.
  const orchestrator = createOrchestrator()

  // Builds the Operator's governed control client for the currently resolved identity scoped to
  // the zone the conversation acts in, or null when governed execution is not fully configured —
  // no identity, or the control plane is disabled. The Operator governs every zone it operates in:
  // for its own (system) zone it acts directly; for any tenant zone the client carries a zone-scope
  // header the in-process control handler honors for the reserved Operator subject, so the
  // approval-gated mutation is applied in the conversation's zone without provisioning an identity
  // there. Resolved per request because the identity is populated after the system zone is
  // provisioned at startup; constructing the client is cheap. A null result means execution refuses
  // rather than falling back to any other authority.
  const resolveControlClient = (zoneId: string, authorizedBy?: string, coAuthorOperator?: boolean): { client: ControlClient; identity: OperatorControlIdentity } | null => {
    const identity = opts.resolveControlIdentity?.() ?? null
    if (!identity || !opts.controlEndpoints) return null
    const zoneScope = identity.zoneId === zoneId ? undefined : zoneId
    const client = buildOperatorControlClient(identity, opts.controlEndpoints, opts.fetchImpl, zoneScope, authorizedBy, coAuthorOperator)
    return client ? { client, identity } : null
  }

  // Builds a read-only researcher that grounds an answer in the conversation zone's live state
  // through a governed mandate. The Operator acts as its single reserved system-zone identity in
  // every zone: for caracal.sys it reads directly; for any tenant zone the control client carries a
  // zone-scope header the in-process control handler honors for the reserved Operator subject, so
  // live state is read without provisioning any identity in the tenant zone. The worker is narrowed
  // to the read role, so it can never mint a write token regardless of what the zone-scope header
  // permits; every change still flows through the approval-gated execution path. Null when
  // self-governance is not configured, in which case the read agents say live state could not be
  // read rather than guess.
  const resolveZoneResearcher = (zoneId: string): ReturnType<typeof createStateResearcher> | null => {
    const identity = opts.resolveControlIdentity?.() ?? null
    if (!identity || !opts.controlEndpoints) return null
    const zoneScope = identity.zoneId === zoneId ? undefined : zoneId
    const client = buildOperatorControlClient(identity, opts.controlEndpoints, opts.fetchImpl, zoneScope)
    if (!client) return null
    return createStateResearcher(createRoleScopedClient(client, 'researcher', roleScopes('researcher', authority)))
  }

  // Always cheap and always present so the console can render a precise enabled/disabled
  // state without inferring it from a missing route. When enabled it also exposes the
  // Operator's reserved principal and the capabilities it is permitted to execute, so
  // the least-privilege boundary is visible rather than implicit.
  fastify.get('/operator/status', async () => {
    if (!opts.enabled) return { enabled: false }
    const identity = opts.resolveControlIdentity?.() ?? null
    // The reserved system zone may be provisioned even when governed execution is not yet
    // configured, so resolve its id by slug independently. It is the source for the Console's
    // read-only "Open System Zone" viewer, which must be reachable whenever the zone exists, not
    // only when the dogfooding identity is live.
    const sysRows = (await fastify.db.query<{ id: string }>('SELECT id FROM zones WHERE slug = $1 LIMIT 1', [SYSTEM_ZONE_SLUG]))?.rows ?? []
    const systemZoneId = sysRows[0]?.id ?? null
    return {
      enabled: true,
      principal: authority.principal,
      allowed_capabilities: [...authority.allowedCapabilities].sort(),
      // The reserved system zone's id, when it exists, so the Console can open it read-only.
      system_zone_id: systemZoneId,
      // Whether the Operator's governed-execution identity is provisioned, and the reserved
      // system zone it is bound to. The Operator governs every zone it operates in from this one
      // identity; the zone here names its home (system) zone, surfaced so an operator can confirm
      // the dogfooding identity is configured without inspecting secrets. The credential itself is
      // never exposed.
      governed_execution: identity ? { configured: true, zone_id: identity.zoneId } : { configured: false },
      // Whether Caracal-governed autopilot is available in this deployment: the master switch is
      // on. When available, an engaged conversation has its plan approvals auto-satisfied; the
      // switch is read-only here and set in Caracal, never through the console.
      autopilot: { available: autopilotAvailable(autopilotPolicy) },
    }
  })

  // When the Operator is disabled it registers no functional routes, so it holds no
  // catalog, runs no queries, and consumes nothing beyond the status probe above.
  if (!opts.enabled) return

  // Reports which AI providers are configured, in failover order, never exposing
  // keys. The console uses this to show whether the AI tier is available.
  fastify.get('/operator/ai/status', async () => {
    return buildGateway().status()
  })

  // Verifies AI connectivity by sending a minimal completion through the failover
  // chain. This is the one place a real provider call is made on an explicit operator
  // action, so an operator can confirm their bring-your-own-key configuration works.
  fastify.post('/operator/ai/check', async (_req, reply) => {
    const started = Date.now()
    try {
      const result = await buildGateway().complete(
        [
          { role: 'system', content: 'You are a connectivity probe. Reply with the single word OK.' },
          { role: 'user', content: 'OK' },
        ],
        { maxTokens: 5, temperature: 0 },
      )
      return {
        ok: true,
        provider: result.provider,
        model: result.model,
        latency_ms: Date.now() - started,
      }
    } catch (err) {
      if (err instanceof GatewayUnavailableError) {
        return reply.code(409).send({ error: 'ai_unavailable' })
      }
      if (err instanceof GatewayError) {
        return reply.code(502).send({ error: 'ai_unreachable', attempts: err.attempts })
      }
      throw err
    }
  })

  fastify.get('/operator/capabilities', async () => {
    return { capabilities: listCapabilities() }
  })

  // Governed model-provider management. These routes seal an upstream key into the reserved
  // caracal.sys system zone and reconcile the Operator's grants, so a provider added here is
  // governed exactly as a customer's resource is. They require self-governance to be configured;
  // without it there is no authority plane to seal a key into, so a write is refused rather than
  // holding the key unprotected.
  const ProviderSlug = z.string().regex(PROVIDER_SLUG_PATTERN)
  const ProviderModels = z.array(z.string().trim().min(1).max(120)).min(1).max(20)
  const ProviderBaseUrl = z.string().trim().url().max(400)
  // Where the sealed key is injected. A discriminated union mirrors the provider contract: a
  // header carries a name and an optional scheme; a query carries a parameter name and forbids a
  // scheme. Omitted, it defaults to an Authorization Bearer header, so the common case sends none.
  const AuthBody = z
    .discriminatedUnion('location', [
      z.object({
        location: z.literal('header'),
        header_name: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/)
          .default('Authorization'),
        auth_scheme: z.string().trim().max(32).optional(),
      }),
      z.object({
        location: z.literal('query'),
        query_param_name: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_.-]{1,64}$/)
          .default('api_key'),
      }),
    ])
    .optional()
  const toAuthPlacement = (auth: z.infer<typeof AuthBody>) =>
    auth === undefined || auth.location === 'header'
      ? {
          location: 'header' as const,
          headerName: auth?.header_name ?? 'Authorization',
          authScheme: auth?.location === 'header' ? auth.auth_scheme : 'Bearer',
        }
      : { location: 'query' as const, queryParamName: auth.query_param_name }
  const CreateProviderBody = z
    .object({
      slug: ProviderSlug,
      label: z.string().trim().min(1).max(80),
      base_url: ProviderBaseUrl,
      models: ProviderModels,
      context_window: z.number().int().min(0).max(10_000_000).default(0),
      api_key: z.string().min(1).max(8000),
      enabled: z.boolean().default(true),
      auth: AuthBody,
    })
    .strict()
  const UpdateProviderBody = z
    .object({
      label: z.string().trim().min(1).max(80).optional(),
      base_url: ProviderBaseUrl.optional(),
      models: ProviderModels.optional(),
      context_window: z.number().int().min(0).max(10_000_000).optional(),
      enabled: z.boolean().optional(),
      auth: AuthBody,
    })
    .strict()
  const RotateKeyBody = z.object({ api_key: z.string().min(1).max(8000) }).strict()
  const ProviderSlugParams = z.object({ slug: ProviderSlug })

  // Maps a manager error to its HTTP shape: a missing governance prerequisite is a 409 the
  // console explains, and an unknown provider is a 404. Any other error propagates to the
  // shared handler.
  function sendAiError(reply: FastifyReply, err: unknown): boolean {
    if (err instanceof OperatorAiUnavailableError) {
      reply.code(409).send({ error: 'governed_execution_unconfigured' })
      return true
    }
    if (err instanceof OperatorAiNotFoundError) {
      reply.code(404).send({ error: 'provider_not_found' })
      return true
    }
    return false
  }

  fastify.get('/operator/ai/providers', async () => {
    const providers = opts.aiManager ? await opts.aiManager.list() : []
    return { providers, available: opts.aiManager?.available() ?? false }
  })

  fastify.post('/operator/ai/providers', async (req, reply) => {
    if (!opts.aiManager) return reply.code(409).send({ error: 'governed_execution_unconfigured' })
    const parsed = CreateProviderBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider' })
    try {
      const provider = await opts.aiManager.create({
        slug: parsed.data.slug,
        label: parsed.data.label,
        baseUrl: parsed.data.base_url,
        models: parsed.data.models,
        contextWindow: parsed.data.context_window,
        apiKey: parsed.data.api_key,
        enabled: parsed.data.enabled,
        auth: toAuthPlacement(parsed.data.auth),
      })
      return reply.code(201).send(provider)
    } catch (err) {
      if (sendAiError(reply, err)) return
      throw err
    }
  })

  fastify.patch('/operator/ai/providers/:slug', async (req, reply) => {
    if (!opts.aiManager) return reply.code(409).send({ error: 'governed_execution_unconfigured' })
    const params = ProviderSlugParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid_provider' })
    const parsed = UpdateProviderBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider' })
    try {
      const provider = await opts.aiManager.update(params.data.slug, {
        label: parsed.data.label,
        baseUrl: parsed.data.base_url,
        models: parsed.data.models,
        contextWindow: parsed.data.context_window,
        enabled: parsed.data.enabled,
        auth: parsed.data.auth ? toAuthPlacement(parsed.data.auth) : undefined,
      })
      return provider
    } catch (err) {
      if (sendAiError(reply, err)) return
      throw err
    }
  })

  fastify.post('/operator/ai/providers/:slug/key', async (req, reply) => {
    if (!opts.aiManager) return reply.code(409).send({ error: 'governed_execution_unconfigured' })
    const params = ProviderSlugParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid_provider' })
    const parsed = RotateKeyBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider' })
    try {
      await opts.aiManager.rotateKey(params.data.slug, parsed.data.api_key)
      return { ok: true }
    } catch (err) {
      if (sendAiError(reply, err)) return
      throw err
    }
  })

  fastify.delete('/operator/ai/providers/:slug', async (req, reply) => {
    if (!opts.aiManager) return reply.code(409).send({ error: 'governed_execution_unconfigured' })
    const params = ProviderSlugParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid_provider' })
    try {
      const removed = await opts.aiManager.remove(params.data.slug)
      if (!removed) return reply.code(404).send({ error: 'provider_not_found' })
      return reply.code(204).send()
    } catch (err) {
      if (sendAiError(reply, err)) return
      throw err
    }
  })

  fastify.post('/zones/:zoneId/operator-conversations', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    // The Operator is isolated from system zones: it will not even open a session
    // against one, so its authority can never reach system infrastructure.
    if (isZoneIsolated(authority, params.zoneId)) {
      return reply.code(403).send({ error: 'zone_forbidden' })
    }
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const parsed = CreateConversationBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_conversation' })
    const id = uuidv7()
    // A conversation opens in agent mode with autopilot disengaged unless explicitly created
    // otherwise. Mode and the autopilot engage flag are Caracal-side settings on the conversation;
    // the model never selects or changes them. Engaging autopilot here only sets the engage flag —
    // what may be auto-approved is still bounded by the deployment's autopilot policy.
    // The number is drawn from a durable per-zone counter that only ever advances, so a number is
    // consumed once and never handed out again even after the conversation that held it is deleted.
    const { rows } = await fastify.db.query(
      `WITH allocated AS (
         INSERT INTO operator_conversation_counters (zone_id, next_number)
         VALUES ($2, 1)
         ON CONFLICT (zone_id) DO UPDATE SET next_number = operator_conversation_counters.next_number + 1
         RETURNING next_number
       )
       INSERT INTO operator_conversations (id, zone_id, number, title, mode, autopilot, created_by)
       VALUES ($1, $2, (SELECT next_number FROM allocated), $3, $4, $5, $6)
       RETURNING ${CONVERSATION_SELECT}`,
      [id, params.zoneId, parsed.data.title, parsed.data.mode ?? 'agent', parsed.data.autopilot ?? false, req.actor.id],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.get('/zones/:zoneId/operator-conversations', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const search = ListSearchQuery.safeParse(req.query ?? {})
    if (!search.success) return reply.code(400).send({ error: 'invalid_query' })

    const base: { conds: string[]; values: unknown[] } = {
      conds: ['zone_id = $1'],
      values: [params.zoneId],
    }
    if (search.data.status === 'active') base.conds.push('archived_at IS NULL')
    else if (search.data.status === 'archived') base.conds.push('archived_at IS NOT NULL')
    if (search.data.q) {
      // Match the term as a literal substring: LIKE wildcards in user input are
      // escaped so a query like "50%" cannot widen the match. ESCAPE is explicit.
      base.values.push(escapeLikeTerm(search.data.q))
      base.conds.push(`title ILIKE '%' || $${base.values.length} || '%' ESCAPE '\\'`)
    }
    const keyset = appendKeysetCondition(base, page)
    const { rows } = await fastify.db.query(
      `SELECT ${CONVERSATION_SELECT}
       FROM operator_conversations WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    setNextLink(req, reply, rows, page.limit)
    return rows
  })

  fastify.get('/zones/:zoneId/operator-conversations/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT ${CONVERSATION_SELECT}
       FROM operator_conversations WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'conversation_not_found' })
    return rows[0]
  })

  fastify.patch('/zones/:zoneId/operator-conversations/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = PatchConversationBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_conversation' })
    const body = parsed.data
    if (body.title === undefined && body.status === undefined && body.mode === undefined && body.autopilot === undefined) {
      return reply.code(400).send({ error: 'no_fields' })
    }
    const { rows } = await fastify.db.query(
      `UPDATE operator_conversations
       SET title = COALESCE($3, title),
           status = COALESCE($4, status),
           mode = COALESCE($5, mode),
           autopilot = COALESCE($6, autopilot),
           archived_at = CASE
             WHEN $4 = 'archived' THEN now()
             WHEN $4 = 'active' THEN NULL
             ELSE archived_at
           END,
           updated_at = now()
       WHERE id = $1 AND zone_id = $2
       RETURNING ${CONVERSATION_SELECT}`,
      [params.id, params.zoneId, body.title ?? null, body.status ?? null, body.mode ?? null, body.autopilot ?? null],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'conversation_not_found' })
    return rows[0]
  })

  fastify.delete('/zones/:zoneId/operator-conversations/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    // The turns ledger is removed with the conversation through the ON DELETE CASCADE
    // foreign key, so a single statement clears the whole session.
    const { rowCount } = await fastify.db.query(`DELETE FROM operator_conversations WHERE id = $1 AND zone_id = $2`, [
      params.id,
      params.zoneId,
    ])
    if (!rowCount) return reply.code(404).send({ error: 'conversation_not_found' })
    return reply.code(204).send()
  })

  fastify.post('/zones/:zoneId/operator-conversations/:id/turns', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = AppendTurnBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_turn' })
    const body = parsed.data
    const validated = parseTurnContent(body.kind as TurnKind, body.content)
    if (!validated.ok) return reply.code(400).send({ error: 'invalid_turn_content' })
    const contentJson = JSON.stringify(validated.content)
    if (Buffer.byteLength(contentJson, 'utf8') > CONTENT_MAX_BYTES) {
      return reply.code(400).send({ error: 'content_too_large' })
    }

    return withTransaction(fastify.db, async (client) => {
      // Lock the conversation row so concurrent appends allocate a gapless,
      // strictly increasing seq without colliding on the (conversation_id, seq) key.
      const { rows: conv } = await client.query<{ status: string; next_seq: number }>(
        `SELECT status, next_seq FROM operator_conversations
         WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
        [params.id, params.zoneId],
      )
      if (!conv[0]) throw new TxAbort(reply.code(404).send({ error: 'conversation_not_found' }))
      if (conv[0].status !== 'active') {
        throw new TxAbort(reply.code(409).send({ error: 'conversation_archived' }))
      }

      if (body.client_token) {
        const { rows: existing } = await client.query(
          `SELECT ${TURN_SELECT} FROM operator_turns
           WHERE conversation_id = $1 AND client_token = $2`,
          [params.id, body.client_token],
        )
        if (existing[0]) return reply.code(200).send(existing[0])
      }

      const row = await writeTurnLocked(client, {
        conversationId: params.id,
        zoneId: params.zoneId,
        seq: conv[0].next_seq,
        role: body.role,
        kind: body.kind,
        contentJson,
        actorId: req.actor.id,
        clientToken: body.client_token,
      })
      return reply.code(201).send(row)
    })
  })

  fastify.get('/zones/:zoneId/operator-conversations/:id/turns', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const query = TurnQuery.safeParse(req.query ?? {})
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' })
    const { after_seq: afterSeq, limit } = query.data
    const { rows } = await fastify.db.query<{ seq: number }>(
      `SELECT ${TURN_SELECT} FROM operator_turns
       WHERE conversation_id = $1 AND zone_id = $2 AND seq > $3
       ORDER BY seq ASC LIMIT $4`,
      [params.id, params.zoneId, afterSeq, limit],
    )
    if (rows.length === limit) {
      const last = rows[rows.length - 1]
      const url = new URL(req.url, 'http://internal')
      url.searchParams.set('after_seq', String(last.seq))
      url.searchParams.set('limit', String(limit))
      reply.header('link', `<${url.pathname}${url.search}>; rel="next"`)
    }
    return rows
  })

  fastify.get('/zones/:zoneId/operator-conversations/:id/context', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const query = ContextQuery.safeParse(req.query ?? {})
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' })

    const { rows: conv } = await fastify.db.query<{ status: string; next_seq: string | number }>(
      `SELECT status, next_seq FROM operator_conversations WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!conv[0]) return reply.code(404).send({ error: 'conversation_not_found' })

    const [state, facts] = await Promise.all([
      loadConversationState(fastify.db, params.id, params.zoneId, query.data.message_window),
      loadConversationFacts(fastify.db, params.id, params.zoneId),
    ])

    return {
      conversation_id: params.id,
      status: conv[0].status,
      turn_count: Math.max(0, Number(conv[0].next_seq) - 1),
      facts,
      ...state,
    }
  })

  fastify.post('/zones/:zoneId/operator-conversations/:id/plan/validate', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = ProposedPlan.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_plan' })

    const { rows: conv } = await fastify.db.query<{ status: string }>(
      `SELECT status FROM operator_conversations WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!conv[0]) return reply.code(404).send({ error: 'conversation_not_found' })

    return validateProposedPlan(parsed.data)
  })

  fastify.post('/zones/:zoneId/operator-conversations/:id/plan/preview', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = ProposedPlan.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_plan' })

    const { rows: conv } = await fastify.db.query<{ status: string }>(
      `SELECT status FROM operator_conversations WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!conv[0]) return reply.code(404).send({ error: 'conversation_not_found' })

    return previewPlan(fastify.db, params.zoneId, parsed.data)
  })

  fastify.post('/zones/:zoneId/operator-conversations/:id/plan', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = ProposedPlan.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_plan' })

    const validation = validateProposedPlan(parsed.data)
    if (!validation.ok) {
      return reply.code(400).send({ error: 'plan_validation_failed', validation })
    }

    const contentJson = buildPlanContentJson(parsed.data.summary, validation)

    return withTransaction(fastify.db, async (client) => {
      const { rows: conv } = await client.query<{ status: string; mode: string; next_seq: number }>(
        `SELECT status, mode, next_seq FROM operator_conversations
         WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
        [params.id, params.zoneId],
      )
      if (!conv[0]) throw new TxAbort(reply.code(404).send({ error: 'conversation_not_found' }))
      if (conv[0].status !== 'active') {
        throw new TxAbort(reply.code(409).send({ error: 'conversation_archived' }))
      }
      // Ask mode is read-only: a plan is a change artifact, so it is refused regardless of how the
      // caller produced it. This is the write-path half of mode enforcement, independent of the
      // orchestrator's skill filter, so a plan can never enter an ask conversation's ledger.
      if (conv[0].mode === 'ask') {
        throw new TxAbort(reply.code(403).send({ error: 'mode_forbidden' }))
      }
      const turn = await writeTurnLocked(client, {
        conversationId: params.id,
        zoneId: params.zoneId,
        seq: conv[0].next_seq,
        role: 'operator',
        kind: 'plan',
        contentJson,
        actorId: req.actor.id,
      })
      return reply.code(201).send({ turn, validation })
    })
  })

  fastify.post('/zones/:zoneId/operator-conversations/:id/plan/decision', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = PlanDecisionBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_decision' })
    const body = parsed.data
    const kind = body.decision === 'approved' ? 'approval' : 'rejection'
    const content =
      kind === 'rejection' && body.reason !== undefined ? { plan_seq: body.plan_seq, reason: body.reason } : { plan_seq: body.plan_seq }
    const contentJson = JSON.stringify(content)

    return withTransaction(fastify.db, async (client) => {
      const { rows: conv } = await client.query<{ status: string; mode: string; next_seq: number }>(
        `SELECT status, mode, next_seq FROM operator_conversations
         WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
        [params.id, params.zoneId],
      )
      if (!conv[0]) throw new TxAbort(reply.code(404).send({ error: 'conversation_not_found' }))
      if (conv[0].status !== 'active') {
        throw new TxAbort(reply.code(409).send({ error: 'conversation_archived' }))
      }
      // Ask mode is read-only: it has no plans to decide, and an approval is the gate that lets a
      // change apply. The decision endpoint is refused so an ask conversation has no path that
      // could authorize a change.
      if (conv[0].mode === 'ask') {
        throw new TxAbort(reply.code(403).send({ error: 'mode_forbidden' }))
      }
      // The decision must reference an actual plan turn in this conversation.
      const { rows: planTurn } = await client.query(
        `SELECT 1 FROM operator_turns
         WHERE conversation_id = $1 AND zone_id = $2 AND seq = $3 AND kind = 'plan'`,
        [params.id, params.zoneId, body.plan_seq],
      )
      if (!planTurn[0]) throw new TxAbort(reply.code(404).send({ error: 'plan_not_found' }))

      // A plan is decided exactly once; a second approval or rejection is refused so
      // the ledger holds a single, unambiguous authority decision per plan.
      const { rows: decided } = await client.query(
        `SELECT 1 FROM operator_turns
         WHERE conversation_id = $1 AND zone_id = $2
           AND kind IN ('approval', 'rejection')
           AND (content->>'plan_seq')::bigint = $3`,
        [params.id, params.zoneId, body.plan_seq],
      )
      if (decided[0]) throw new TxAbort(reply.code(409).send({ error: 'plan_already_decided' }))

      const turn = await writeTurnLocked(client, {
        conversationId: params.id,
        zoneId: params.zoneId,
        seq: conv[0].next_seq,
        role: 'user',
        kind,
        contentJson,
        actorId: req.actor.id,
      })
      return reply.code(201).send(turn)
    })
  })

  fastify.post('/zones/:zoneId/operator-conversations/:id/plan/execute', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = ExecutePlanBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_execute' })
    const planSeq = parsed.data.plan_seq
    // Isolation is checked before any work: the Operator never executes in a system zone.
    if (isZoneIsolated(authority, params.zoneId)) {
      return reply.code(403).send({ error: 'zone_forbidden' })
    }

    // Governed execution is the only execution path. It requires the Operator's reserved
    // control identity and an enabled control plane. The Operator governs every zone it operates
    // in: the control client is scoped to the conversation's zone, and the in-process control
    // handler executes each command in that zone for the reserved Operator subject. A deployment
    // without a governed identity or control plane has no execution path, so it refuses rather
    // than applying changes as any other authority. There is no admin-actor fallback. The
    // executing actor rides as the audit attribution so every governed mutation in the
    // tamper-evident control audit names the human who applied the plan.
    const governed = resolveControlClient(params.zoneId, req.account?.name ?? req.account?.email ?? req.actor.id, true)
    if (!governed) {
      return reply.code(409).send({ error: 'governed_execution_unconfigured' })
    }
    const controlClient = governed.client

    const lockKey = `operator:exec:${params.zoneId}:${params.id}:${planSeq}`
    // An owner token so the lock is only ever released by the request that holds it; a
    // request whose lock expired must not delete a lock since acquired by another.
    const lockOwner = uuidv7()
    const locked = await fastify.redis.set(lockKey, lockOwner, 'EX', EXECUTE_LOCK_TTL_SEC, 'NX')
    if (locked !== 'OK') return reply.code(409).send({ error: 'plan_already_executed' })

    try {
      // Pre-flight: read-only validation in one short transaction. Resolves the approved,
      // not-yet-executed, still-valid, still-unblocked plan to the steps to execute. It
      // writes nothing, so the governed control calls below run outside any transaction.
      const pre = await withTransaction(fastify.db, async (client): Promise<PreflightResult> => {
        const { rows: conv } = await client.query<{ status: string; mode: string }>(
          `SELECT status, mode FROM operator_conversations WHERE id = $1 AND zone_id = $2`,
          [params.id, params.zoneId],
        )
        if (!conv[0]) return { ok: false, status: 404, body: { error: 'conversation_not_found' } }
        if (conv[0].status !== 'active') return { ok: false, status: 409, body: { error: 'conversation_archived' } }
        // Ask mode is read-only: execution is the apply step, so it is refused even if a plan and
        // an approval somehow exist. With the plan and decision endpoints also refusing in ask
        // mode, an ask conversation has no reachable path to apply a change.
        if (conv[0].mode === 'ask') return { ok: false, status: 403, body: { error: 'mode_forbidden' } }

        const { rows: planRows } = await client.query<{ content: PlanTurnContent }>(
          `SELECT content FROM operator_turns
           WHERE conversation_id = $1 AND zone_id = $2 AND seq = $3 AND kind = 'plan'`,
          [params.id, params.zoneId, planSeq],
        )
        if (!planRows[0]) return { ok: false, status: 404, body: { error: 'plan_not_found' } }

        const { rows: decision } = await client.query<{ kind: string }>(
          `SELECT kind FROM operator_turns
           WHERE conversation_id = $1 AND zone_id = $2
             AND kind IN ('approval', 'rejection')
             AND (content->>'plan_seq')::bigint = $3
           LIMIT 1`,
          [params.id, params.zoneId, planSeq],
        )
        if (!decision[0]) return { ok: false, status: 409, body: { error: 'plan_not_approved' } }
        if (decision[0].kind === 'rejection') return { ok: false, status: 409, body: { error: 'plan_rejected' } }

        // Read every prior execution turn for this plan to decide retriability at the step
        // level. A failed step means a non-idempotent mutation may have half-applied, so the
        // whole plan is never retriable. Otherwise every recorded step succeeded, and a plan
        // that stopped on a definitive, nothing-applied failure can be resumed from its first
        // unapplied step rather than refused outright.
        const { rows: priorSteps } = await client.query<{ step_id: string; status: string }>(
          `SELECT content->>'step_id' AS step_id, content->>'status' AS status
           FROM operator_turns
           WHERE conversation_id = $1 AND zone_id = $2 AND kind = 'execution'
             AND (content->>'plan_seq')::bigint = $3`,
          [params.id, params.zoneId, planSeq],
        )
        if (priorSteps.some((row) => row.status === 'failed')) {
          return { ok: false, status: 409, body: { error: 'plan_already_executed' } }
        }
        const appliedStepIds = new Set(priorSteps.filter((row) => row.status === 'succeeded').map((row) => row.step_id))

        const steps = planRows[0].content.steps.map((step) => ({
          id: step.id,
          capability: step.capability,
          args: step.args ?? {},
        }))

        // Re-validate the whole persisted plan against the live catalog before applying anything.
        const revalidation = validateProposedPlan({ summary: planRows[0].content.summary, steps })
        if (!revalidation.ok) return { ok: false, status: 409, body: { error: 'plan_invalid', validation: revalidation } }

        // Resume applies only the steps not already applied. A plan whose every step already
        // succeeded is fully executed and is refused as such.
        const remaining = steps.filter((step) => !appliedStepIds.has(step.id))
        if (remaining.length === 0) return { ok: false, status: 409, body: { error: 'plan_already_executed' } }

        // Authority is the primary boundary: a mutating step outside the Operator's
        // least-privilege grant is forbidden before executability is even considered.
        const denials = authorizePlanSteps(authority, remaining)
        if (denials.length > 0) {
          return { ok: false, status: 403, body: { error: 'capability_forbidden', principal: authority.principal, steps: denials } }
        }

        // Every step must map to a governed control command; one that does not is refused
        // rather than applied by any other means.
        const unsupported = remaining.filter((step) => !isControlExecutable(step.capability))
        if (unsupported.length > 0) {
          return {
            ok: false,
            status: 422,
            body: { error: 'capability_not_executable', steps: unsupported.map((s) => ({ step_id: s.id, capability: s.capability })) },
          }
        }

        // Re-preview against current state; a now-blocked step stops the plan before any call.
        const preview = await previewPlan(client, params.zoneId, { summary: planRows[0].content.summary, steps: remaining })
        if (!preview.ok) return { ok: false, status: 409, body: { error: 'plan_blocked', preview } }

        // A create step whose target now already exists would duplicate it, so the plan is
        // refused rather than applied — re-running must never silently create a second one.
        const existing = preview.steps.filter((step) => step.effect === 'exists')
        if (existing.length > 0) {
          return {
            ok: false,
            status: 409,
            body: {
              error: 'plan_already_satisfied',
              steps: existing.map((step) => ({ step_id: step.id, capability: step.capability, detail: step.detail })),
            },
          }
        }

        return { ok: true, summary: planRows[0].content.summary, steps: remaining }
      })

      if (!pre.ok) return reply.code(pre.status).send(pre.body)
      // Apply the plan through the control plane as the Operator's scoped identity, spawned under
      // the executor role: the control client is bounded to exactly the scopes the Operator's
      // authority grants, so a write scope it was never granted can never be minted even if a step
      // slipped past the authority check. Each step mints a least-privilege token and invokes its
      // governed control command; the control plane authorizes, executes, and audits it natively. A
      // denial or failure stops the plan, so it never silently half-applies.
      const executor = createRoleScopedClient(controlClient, 'executor', roleScopes('executor', authority))
      const result = await executeViaControlPlane(executor, pre.steps)

      // Record the applied steps and any failure in the ledger. The control plane already
      // wrote the tamper-evident admin audit for each mutation, so no manual audit record
      // is written here — the execution turn carries the Operator principal that applied it.
      const recorded = await withTransaction(fastify.db, async (client) => {
        const { rows: conv } = await client.query<{ status: string; next_seq: number }>(
          `SELECT status, next_seq FROM operator_conversations WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
          [params.id, params.zoneId],
        )
        const turns: Record<string, unknown>[] = []
        const outputs: Record<string, Record<string, unknown>> = {}
        // The mutations have already been applied to the control plane, so the ledger must record
        // them — and the execution turn that records a step is also the dedup marker that blocks a
        // re-run. Recording therefore proceeds even if the conversation was archived in the window
        // between applying the plan and this transaction: the applied work is real and must be
        // reflected truthfully, and the dedup turn must be written so a re-activated conversation
        // cannot re-apply a non-idempotent step. Only a hard delete (the row is gone, so the
        // cascade already removed the whole plan ledger and there is nothing left to re-run
        // against) leaves nothing to record.
        if (!conv[0]) return { turns, outputs }
        let seq = conv[0].next_seq
        for (const step of result.applied) {
          const turn = await writeTurnLocked(client, {
            conversationId: params.id,
            zoneId: params.zoneId,
            seq,
            role: 'operator',
            kind: 'execution',
            contentJson: JSON.stringify({
              plan_seq: planSeq,
              step_id: step.id,
              status: 'succeeded',
              detail: step.detail,
              executed_by: authority.principal,
            }),
            actorId: req.actor.id,
          })
          turns.push(turn)
          seq += 1
          if (step.output) outputs[step.id] = step.output
        }
        if (result.failure) {
          // When a step partially applied a plan, or its failure is terminal (the mutation
          // may have been applied), record the failed step as an execution turn. That marks
          // the step failed in plan state and — because any execution turn for this plan
          // blocks a re-run — makes the plan non-retriable, so a possibly-applied mutation
          // is never applied twice. A definitive, nothing-applied failure writes no
          // execution turn, leaving the plan safe to retry.
          if (result.applied.length > 0 || result.failure.terminal) {
            await writeTurnLocked(client, {
              conversationId: params.id,
              zoneId: params.zoneId,
              seq,
              role: 'operator',
              kind: 'execution',
              contentJson: JSON.stringify({
                plan_seq: planSeq,
                step_id: result.failure.stepId,
                status: 'failed',
                detail: result.failure.reason.slice(0, 2000),
                executed_by: authority.principal,
              }),
              actorId: req.actor.id,
            })
            seq += 1
          }
          await writeTurnLocked(client, {
            conversationId: params.id,
            zoneId: params.zoneId,
            seq,
            role: 'system',
            kind: 'error',
            contentJson: JSON.stringify({
              message: `Step ${result.failure.stepId} (${result.failure.capability}) failed: ${result.failure.reason}`,
            }),
            actorId: req.actor.id,
          })
        }
        // A clean apply is durable, governed knowledge of the zone: record it as a persistent,
        // zone-scoped memory so a later conversation recalls what was configured here. Memory is
        // written only for a fully applied plan, inside this transaction, so it reflects an
        // approved outcome Caracal actually applied — never a proposal or a partial failure.
        if (!result.failure && result.applied.length > 0) {
          await rememberAppliedChange(client, params.zoneId, params.id, pre.summary)
        }
        return { turns, outputs }
      })

      if (result.failure) {
        return reply.code(422).send({ error: 'execution_failed', step_id: result.failure.stepId, applied: recorded.turns })
      }

      // Return the applied result immediately — including any one-time output such as an issued
      // client secret — so the caller receives the secret the instant the apply is durable, never
      // gated behind the advisory verification's model call.
      reply
        .code(201)
        .send({ ok: true, plan_seq: planSeq, executed_by: authority.principal, executed: recorded.turns, outputs: recorded.outputs })

      // Post-execution verification (best-effort, advisory) runs in the background after the response
      // is sent. The mutations are already durable, so this never gates or reverses the apply: it
      // reads live state once more and judges whether the applied result matches the plan's intent,
      // recording the verdict as a note the human sees on the next refresh. A drift verdict only
      // informs and recommends a correction — that correction still flows through the governed
      // propose-approve-apply path, so verification holds no authority. It runs only when the AI
      // gateway is enabled and a governed reader is available for the zone, and any failure is
      // swallowed so the apply's success is never affected by an unverifiable turn.
      const verifyGateway = buildGateway()
      const verifier = resolveZoneResearcher(params.zoneId)
      if (verifyGateway.status().enabled && verifier) {
        void (async () => {
          try {
            const domains = [
              ...new Set(pre.steps.map((step) => CAPABILITIES[step.capability]?.domain).filter((d): d is CapabilityDomain => !!d)),
            ]
            const blackboard = await verifier.gather(domains)
            const verifyContext: AgentContext = { facts: null, state: null, evidence: blackboard.evidence }
            const verdict = await runVerifier(verifyGateway, { summary: pre.summary, steps: pre.steps }, verifyContext)
            if (verdict.ok) {
              const findings = verdict.value.findings.map((f) => f.observation).join('; ')
              const followUp = verdict.value.followUp ? `\n\nRecommended next step: ${verdict.value.followUp}` : ''
              await appendTurnTx(
                fastify.db,
                params.id,
                params.zoneId,
                'operator',
                'note',
                JSON.stringify({
                  text: `Verification (${verdict.value.status}): ${verdict.value.summary}${followUp}`,
                  ...(findings ? { reasoning: findings } : {}),
                  verification: { status: verdict.value.status, summary: verdict.value.summary },
                }),
                req.actor.id,
              )
            }
          } catch {
            // Verification is best-effort: the apply already succeeded and is recorded, so an
            // unverifiable turn is left unverified rather than failing the governed execution.
          }
        })()
      }

      return reply
    } finally {
      // Release the lock only if this request still owns it: a compare-and-delete so an
      // expired-then-reacquired lock held by another request is never deleted here.
      await fastify.redis
        .eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, lockOwner)
        .catch(() => {})
    }
  })

  fastify.post('/zones/:zoneId/operator-conversations/:id/message', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    if (isZoneIsolated(authority, params.zoneId)) {
      return reply.code(403).send({ error: 'zone_forbidden' })
    }
    const parsed = MessageBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_message' })
    const gateway = buildGateway()
    const status = gateway.status()
    if (!status.enabled) return reply.code(409).send({ error: 'ai_unavailable' })

    // A model preference must name an available provider; an unknown or unavailable id is
    // rejected rather than silently ignored, so the console and gateway never disagree.
    const preference = parsed.data.provider ?? null
    if (preference && !status.providers.some((p) => p.id === preference && p.available)) {
      return reply.code(400).send({ error: 'invalid_provider' })
    }

    let messageRun: MessageRunRow | null = null
    let userTurn: AppendOutcome
    if (parsed.data.client_message_id) {
      const started = await startMessageRunTx(fastify.db, {
        conversationId: params.id,
        zoneId: params.zoneId,
        message: parsed.data.message,
        actorId: req.actor.id,
        clientMessageId: parsed.data.client_message_id,
        correlationId: parsed.data.correlation_id ?? parsed.data.client_message_id,
        providerId: preference,
      })
      if (!started.ok) return reply.code(started.status).send(started.body)
      messageRun = started.run
      if (started.duplicate) {
        return reply.code(202).send({ intent: 'message_run', ok: true, duplicate: true, message_run: publicMessageRun(started.run) })
      }
      userTurn = { ok: true, turn: started.turn, mode: started.mode, autopilot: started.autopilot }
    } else {
      // Record the operator's message first, so it is in the ledger regardless of how
      // the agents respond, and so the agents reason over a context that includes it.
      userTurn = await appendTurnTx(
        fastify.db,
        params.id,
        params.zoneId,
        'user',
        'message',
        JSON.stringify({ text: parsed.data.message }),
        req.actor.id,
      )
    }
    if (!userTurn.ok) {
      return reply
        .code(userTurn.reason === 'archived' ? 409 : 404)
        .send({ error: userTurn.reason === 'archived' ? 'conversation_archived' : 'conversation_not_found' })
    }
    messageRun = await transitionMessageRun(fastify.db, messageRun, 'waiting_for_model', { reason: 'model_requested' })

    const [state, facts, zoneMemory, zoneRow] = await Promise.all([
      loadConversationState(fastify.db, params.id, params.zoneId, MESSAGE_CONTEXT_WINDOW),
      loadConversationFacts(fastify.db, params.id, params.zoneId),
      recallZoneMemory(fastify.db, params.zoneId),
      fastify.db.query<{ name: string | null; slug: string | null }>(
        'SELECT name, slug FROM zones WHERE id = $1 LIMIT 1',
        [params.zoneId],
      ),
    ])
    // Ground the agents in their one operating zone. canApply mirrors the execute handler's gate:
    // the Operator governs every zone it operates in, so a conversation can apply changes whenever
    // its governed identity and control plane are configured. The zone-isolation refusal above
    // already excludes the reserved system zones, so any zone that reaches here is governable.
    // Surfacing it lets the Operator say so upfront instead of only confirming at apply time.
    const governedIdentity = opts.resolveControlIdentity?.() ?? null
    const canApply = !!governedIdentity && !!opts.controlEndpoints
    const zoneName = zoneRow.rows[0]?.name ?? zoneRow.rows[0]?.slug ?? 'this zone'
    const context: AgentContext = { facts, state, zoneMemory, zone: { name: zoneName, canApply } }

    // Track the real token usage of every completion made while answering this one
    // message, and report it alongside the model that answered and its context window so
    // the console can show genuine usage. preferProvider routes to the chosen model while
    // the context the agents reason over stays the full conversation history. The per-turn
    // model-call budget bounds how many completions this one message may make.
    const tracked = withUsage(preferProvider(gateway, preference), { maxCalls: opts.aiGovernance?.maxCallsPerTurn })
    const effective = status.providers.find((p) => p.id === preference && p.available) ?? status.providers.find((p) => p.available) ?? null
    const meta = () => {
      const usage = tracked.usage()
      // The model that actually served is reported over the one that was expected, so the console
      // reflects reality after a failover. The served provider's own status carries its context
      // window; when no completion succeeded - a budget refusal before any call - the expected
      // provider stands in so the meta is never empty.
      const served = usage.provider ? (status.providers.find((p) => p.id === usage.provider) ?? null) : null
      const reporting = served ?? effective
      // Caracal fell back when a provider served that is not the one the failover order would try
      // first. A single configured provider, or a turn served entirely by the primary, never flags.
      const failover = effective !== null && usage.providers.some((id) => id !== effective.id)
      return {
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens,
        },
        model: reporting?.model ?? null,
        provider: reporting?.id ?? null,
        max_tokens: reporting?.contextWindow ?? 0,
        ...(failover ? { failover: true } : {}),
      }
    }

    // The console can ask for a live stream by negotiating Server-Sent Events. When it does, the
    // route hijacks the response, opens the stream, and forwards each deliberation stage to it as
    // it happens; the same governed turn then writes one terminal frame carrying the exact body the
    // JSON path would have returned. Streaming changes only when the bytes arrive, never what is
    // decided: validation, preview, approval, and apply are untouched, and a governance or gateway
    // stop becomes a terminal error frame rather than being swallowed.
    const wantsStream = (req.headers.accept ?? '').includes('text/event-stream')
    if (wantsStream) {
      reply.hijack()
      reply.raw.writeHead(200, SSE_HEADERS)
      // Keep the stream's bytes flowing while a model call runs without emitting a frame, so no
      // proxy or browser inactivity deadline mistakes a slow deliberation for a stalled connection.
      // The comment frame names no event, so the console's stream reader ignores it. The socket
      // closing clears the interval, covering every terminal frame and a client disconnect alike.
      const heartbeat = setInterval(() => {
        if (reply.raw.writableEnded) return
        reply.raw.write(': keepalive\n\n')
      }, SSE_HEARTBEAT_MS)
      reply.raw.on('close', () => clearInterval(heartbeat))
    }
    // Capture the deliberation stages as they are emitted, regardless of transport, so the
    // completed turn records how the request was reasoned through and the console can replay the
    // same trail it showed live. The stream still forwards each stage the instant it happens.
    const deliberation: ProgressEvent['stage'][] = []
    const emit: OnProgress = (event: ProgressEvent) => {
      deliberation.push(event.stage)
      if (wantsStream) writeSseEvent(reply, 'stage', event)
    }
    // Delivers a turn's result to the caller: a JSON response on the normal path, or the matching
    // terminal SSE frame on the stream. A status at or above 400 is a stop the human must see, so
    // it is sent as an error frame carrying its status; anything else is the authoritative result.
    const finish = async (
      resultStatus: number,
      body: Record<string, unknown>,
      runState?: { state: MessageRunState; reason?: string; errorCode?: string; errorDetail?: string },
    ) => {
      if (runState) {
        messageRun = await transitionMessageRun(fastify.db, messageRun, runState.state, {
          reason: runState.reason,
          errorCode: runState.errorCode,
          errorDetail: runState.errorDetail,
        })
      }
      const payload = messageRun ? { ...body, message_run: publicMessageRun(messageRun) } : body
      if (!wantsStream) return reply.code(resultStatus).send(payload)
      if (resultStatus < 400) writeSseEvent(reply, 'result', payload)
      else writeSseEvent(reply, 'error', { ...payload, status: resultStatus })
      reply.raw.end()
    }

    try {
      // For a read tier the orchestrator first gathers live state through governed reads, so the
      // answer is grounded in current state rather than the model's guess. The researcher is bound
      // to the conversation's zone: the Operator's system-zone identity is reused for caracal.sys,
      // and for any other zone a least-privilege, read-only reader identity is provisioned in that
      // zone. The worker is further narrowed to the read role, so it can never mint a write token —
      // every change still flows through the approval-gated execution path below. When
      // self-governance is not configured the researcher is null and the answer falls back to
      // conversation context, and the read agents say live state could not be read for this zone.
      const researcher = resolveZoneResearcher(params.zoneId)

      // The conversation's operation mode, read under the lock that recorded the message. In ask
      // mode the orchestrator never produces a plan, so the message path cannot persist one.
      const mode: OperatorMode = userTurn.mode

      // The orchestrator triages the request to its tier and runs the one skill that handles
      // it. A plan outcome flows through validate → preview → store-for-approval; an answer
      // outcome is recorded as a note. The model only proposes — every plan is governed below.
      // Answers are grounded in the bundled documentation corpus so exact names, endpoints, and
      // fields come from the docs rather than the model's recall.
      const { tier, outcome } = await orchestrator.handle(tracked.gateway, parsed.data.message, context, {
        researcher,
        mode,
        docs: (query) => retrieveDocs(query),
        onProgress: emit,
        // Forward each answer delta as a token frame so the console renders the answer as it is
        // produced. Only present when the caller negotiated a stream; the terminal result frame
        // remains the authoritative body.
        onAnswerDelta: wantsStream ? (chunk: string) => writeSseEvent(reply, 'token', { text: chunk }) : undefined,
        // Forward each reasoning delta as a reasoning frame so the console shows the model's
        // thinking live while it works, rather than a blank wait before the answer begins.
        onReasoningDelta: wantsStream ? (chunk: string) => writeSseEvent(reply, 'reasoning', { text: chunk }) : undefined,
      })

      // Defense in depth: ask mode is read-only, so a plan must never be persisted on this path
      // regardless of what the orchestrator returned. The orchestrator already refuses to plan in
      // ask mode; this guarantees it at the route even if that ever regressed.
      if (mode === 'ask' && outcome.kind === 'plan') {
        return finish(403, { error: 'mode_forbidden' }, { state: 'failed', reason: 'mode_forbidden', errorCode: 'mode_forbidden' })
      }

      if (outcome.kind === 'plan') {
        const planned = outcome.result
        if (!planned.ok || planned.value.steps.length === 0) {
          const message = planned.ok ? 'I could not turn that into an action with the capabilities available.' : planned.error
          const turn = await appendTurnTx(
            fastify.db,
            params.id,
            params.zoneId,
            'system',
            'error',
            JSON.stringify({ message }),
            req.actor.id,
          )
          return finish(200, {
            intent: 'plan',
            tier,
            ok: false,
            error: 'no_plan',
            message,
            turn: turn.ok ? turn.turn : null,
            ...meta(),
          }, { state: 'failed', reason: 'no_plan', errorCode: 'no_plan', errorDetail: message })
        }

        // The model only proposes; the deterministic pipeline validates it against
        // the catalog and previews it against live state before it is ever stored as
        // an actionable plan. A plan that fails validation is recorded as an error,
        // never as something an operator can approve.
        const validation = validateProposedPlan(planned.value)
        if (!validation.ok) {
          const turn = await appendTurnTx(
            fastify.db,
            params.id,
            params.zoneId,
            'system',
            'error',
            JSON.stringify({ message: 'The proposed plan did not pass validation.' }),
            req.actor.id,
          )
          return finish(200, {
            intent: 'plan',
            tier,
            ok: false,
            error: 'plan_invalid',
            validation,
            turn: turn.ok ? turn.turn : null,
            ...meta(),
          }, { state: 'failed', reason: 'plan_invalid', errorCode: 'plan_invalid' })
        }

        const preview = await previewPlan(fastify.db, params.zoneId, planned.value)
        // A composed plan carries an advisory security review; the route persists it with the
        // plan and surfaces it to the human. It is informational only — the plan is still
        // governed by validation, preview, and approval, never by this advisory. When the guardian
        // judged the plan misaligned with how Caracal is meant to be used, the orchestrator also
        // produced guidance: the Caracal-correct path the human should take instead. It is surfaced
        // first so the turn teaches the right approach; the plan stays approvable behind the human
        // gate as the deliberate secondary option.
        const advisory = outcome.advisory
        const guidance = outcome.guidance
        const turn = await appendTurnTx(
          fastify.db,
          params.id,
          params.zoneId,
          'operator',
          'plan',
          buildPlanContentJson(planned.value.summary, validation, advisory, deliberation, preview.steps),
          req.actor.id,
        )
        if (!turn.ok) {
          return finish(turn.reason === 'archived' ? 409 : 404, {
            error: turn.reason === 'archived' ? 'conversation_archived' : 'conversation_not_found',
          }, { state: 'failed', reason: turn.reason, errorCode: turn.reason === 'archived' ? 'conversation_archived' : 'conversation_not_found' })
        }

        // Caracal-governed autopilot: in agent mode, when the deployment has enabled autopilot and
        // the conversation has engaged it, Caracal — not the model — auto-satisfies this plan's
        // human approval. An engaged conversation has opted into acting without a human in the loop,
        // so every non-empty plan is approved. If it approves, an approval turn is recorded
        // attributed to autopilot and the operator who is acting; the plan is then ready to apply
        // through the unchanged governed execute path. Autopilot never widens authority — it only
        // fills the approval step, and the execute path still enforces the capability allowlist,
        // least-privilege token, and zone isolation on apply.
        let autoApproved = false
        let approvalTurn: Record<string, unknown> | null = null
        if (turn.mode === 'agent' && turn.autopilot && autopilotAvailable(autopilotPolicy)) {
          const planSeq = Number(turn.turn.seq)
          const decision = mayAutoApprove({ engaged: true, applicable: preview.ok, steps: planned.value.steps }, autopilotPolicy)
          if (decision.autoApprove) {
            const approval = await appendTurnTx(
              fastify.db,
              params.id,
              params.zoneId,
              'system',
              'approval',
              JSON.stringify({ plan_seq: planSeq, autopilot: true }),
              req.actor.id,
            )
            if (approval.ok) {
              autoApproved = true
              approvalTurn = approval.turn
            }
          }
        }

        return finish(201, {
          intent: 'plan',
          tier,
          ok: true,
          turn: turn.turn,
          validation,
          preview,
          advisory,
          guidance,
          auto_approved: autoApproved,
          approval_turn: approvalTurn,
          ...meta(),
        }, { state: autoApproved ? 'completed' : 'waiting_for_user_approval', reason: autoApproved ? 'auto_approved' : 'approval_required' })
      }

      if (outcome.kind === 'policy') {
        const authored = outcome.result
        if (!authored.ok) {
          const turn = await appendTurnTx(
            fastify.db,
            params.id,
            params.zoneId,
            'system',
            'error',
            JSON.stringify({ message: authored.error }),
            req.actor.id,
          )
          return finish(200, {
            intent: 'policy',
            tier,
            ok: false,
            error: 'no_policy',
            message: authored.error,
            turn: turn.ok ? turn.turn : null,
            ...meta(),
          }, { state: 'failed', reason: 'no_policy', errorCode: 'no_policy', errorDetail: authored.error })
        }
        // The authored draft is recorded in the conversation ledger as a note carrying both a
        // human-readable rendering and the structured, validated draft, so the console renders the
        // rich policy view while the ledger stays one narrative. Every document in the draft was
        // validated by Caracal's own contract before it reached here; creating, versioning, and
        // activating it still flow through the governed, approval-gated policy routes, so nothing on
        // this path applies a policy.
        const draft = authored.value
        const policyNote: Record<string, unknown> = { text: renderPolicyDraftText(draft), policy: draft }
        if (deliberation.length > 0) policyNote.deliberation = deliberation
        const turn = await appendTurnTx(fastify.db, params.id, params.zoneId, 'operator', 'note', JSON.stringify(policyNote), req.actor.id)
        if (!turn.ok) {
          return finish(turn.reason === 'archived' ? 409 : 404, {
            error: turn.reason === 'archived' ? 'conversation_archived' : 'conversation_not_found',
          }, { state: 'failed', reason: turn.reason, errorCode: turn.reason === 'archived' ? 'conversation_archived' : 'conversation_not_found' })
        }
        return finish(201, { intent: 'policy', tier, ok: true, policy: draft, turn: turn.turn, ...meta() }, { state: 'completed', reason: 'policy_authored' })
      }

      const explained = outcome.result
      const answer = explained.ok ? explained.value : { text: 'I could not produce an explanation.' }
      const noteContent: Record<string, unknown> = { text: answer.text }
      if (answer.reasoning) noteContent.reasoning = answer.reasoning
      if (deliberation.length > 0) noteContent.deliberation = deliberation
      const turn = await appendTurnTx(fastify.db, params.id, params.zoneId, 'operator', 'note', JSON.stringify(noteContent), req.actor.id)
      return finish(201, {
        intent: 'explain',
        tier,
        ok: explained.ok,
        text: answer.text,
        reasoning: answer.reasoning,
        turn: turn.ok ? turn.turn : null,
        ...meta(),
      }, { state: 'completed', reason: 'answer_recorded' })
    } catch (err) {
      if (err instanceof GatewayUnavailableError) return finish(409, { error: 'ai_unavailable' }, { state: 'failed', reason: 'ai_unavailable', errorCode: 'ai_unavailable' })
      if (err instanceof GatewayBudgetError) return finish(429, { error: 'ai_budget_exceeded', max_calls: err.maxCalls }, { state: 'failed', reason: 'ai_budget_exceeded', errorCode: 'ai_budget_exceeded' })
      if (err instanceof GatewayError) return finish(502, { error: 'ai_unreachable', attempts: err.attempts }, { state: 'failed', reason: 'ai_unreachable', errorCode: 'ai_unreachable' })
      // An unexpected failure on the stream has already taken over the response, so it cannot fall
      // through to the framework's error handler; it is closed as a terminal error frame. Durable
      // JSON requests also settle the run before returning the same terminal failure shape.
      if (wantsStream) {
        messageRun = await transitionMessageRun(fastify.db, messageRun, 'failed', { reason: 'ai_failed', errorCode: 'ai_failed' })
        writeSseEvent(reply, 'error', { error: 'ai_failed', status: 500, ...(messageRun ? { message_run: publicMessageRun(messageRun) } : {}) })
        reply.raw.end()
        return
      }
      if (messageRun) return finish(500, { error: 'ai_failed' }, { state: 'failed', reason: 'ai_failed', errorCode: 'ai_failed' })
      throw err
    }
  })
}
