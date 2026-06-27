// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Operator Control API: the authoritative conversation ledger backing Caracal Operator.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { withTransaction, TxAbort, type TxClient, type DB } from '../db.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'
import { parseTurnContent, deriveConversationState, type TurnKind, type TurnRecord } from '../operator-state.js'
import { ProposedPlan, listCapabilities, validateProposedPlan, type PlanValidation } from '../operator-capabilities.js'
import { previewPlan } from '../operator-preview.js'
import { applyPlanSteps, unsupportedSteps, StepExecutionError } from '../operator-execute.js'
import { buildOperatorAuthority, isZoneIsolated, authorizePlanSteps, type OperatorAuthority } from '../operator-authority.js'
import { insertAdminAuditRecord } from '@caracalai/admin-audit'
import { pathOnly } from '@caracalai/core'
import type { OperatorControlIdentity } from '../config.js'
import {
  createGateway,
  withUsage,
  preferProvider,
  GatewayUnavailableError,
  GatewayError,
  type Gateway,
  type ProviderConfig,
} from '../operator-gateway.js'
import { runRouter, runPlanner, runExplainer, type AgentContext } from '../operator-agents.js'
import { summarizeHistory, type ConversationFacts } from '../operator-memory.js'

const TITLE_MAX_LENGTH = 200
const CONTENT_MAX_BYTES = 64_000
const DEFAULT_TURN_PAGE = 200
const MAX_TURN_PAGE = 500

const CONVERSATION_SELECT = 'id, zone_id, title, status, created_by, created_at, updated_at, last_activity_at, archived_at'
const TURN_SELECT = 'id, conversation_id, seq, role, kind, content, actor_id, created_at'

const CreateConversationBody = z.object({ title: z.string().min(1).max(TITLE_MAX_LENGTH) }).strict()

const PatchConversationBody = z
  .object({
    title: z.string().min(1).max(TITLE_MAX_LENGTH).optional(),
    status: z.enum(['active', 'archived']).optional(),
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
    plan_seq: z.number().int().min(1),
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict()

const ExecutePlanBody = z.object({ plan_seq: z.number().int().min(1) }).strict()

const MESSAGE_MAX_LENGTH = 4000
const MessageBody = z
  .object({
    message: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
    // Optional id of the configured provider to answer with. When omitted, the gateway's
    // failover order chooses. Switching it mid-conversation only routes the next message;
    // the conversation history the agents reason over is unchanged.
    provider: z.string().min(1).max(64).optional(),
  })
  .strict()
const MESSAGE_CONTEXT_WINDOW = 10

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

// Builds the catalog-normalized plan content persisted to a plan turn. Each step
// carries its resolved title and the authoritative mutating flag from the catalog,
// so a stored plan can never claim a capability or effect the catalog does not
// grant. Shared by the plan endpoint and the message orchestrator so a plan from
// natural language and a plan from a direct call are stored identically.
function buildPlanContentJson(summary: string, validation: PlanValidation): string {
  return JSON.stringify({
    summary,
    steps: validation.steps.map((step) => ({
      id: step.id,
      capability: step.capability,
      summary: step.title,
      mutating: step.mutating,
      args: step.args,
    })),
  })
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
  const { rows: planRows } = await db.query<{ seq: number }>(
    `SELECT seq FROM operator_turns
     WHERE conversation_id = $1 AND zone_id = $2 AND kind = 'plan'
     ORDER BY seq DESC LIMIT 1`,
    [conversationId, zoneId],
  )
  const planSeq = planRows[0]?.seq ?? null

  const planSlice = planSeq
    ? (
        await db.query<TurnRecord>(
          `SELECT seq, role, kind, content FROM operator_turns
           WHERE conversation_id = $1 AND zone_id = $2 AND seq >= $3
             AND kind IN ('plan', 'approval', 'rejection', 'execution', 'error')
           ORDER BY seq ASC LIMIT $4`,
          [conversationId, zoneId, planSeq, PLAN_WINDOW_LIMIT],
        )
      ).rows
    : []

  const { rows: errorRows } = await db.query<TurnRecord>(
    `SELECT seq, role, kind, content FROM operator_turns
     WHERE conversation_id = $1 AND zone_id = $2 AND kind = 'error'
     ORDER BY seq DESC LIMIT 1`,
    [conversationId, zoneId],
  )

  const { rows: messageRows } = await db.query<TurnRecord>(
    `SELECT seq, role, kind, content FROM operator_turns
     WHERE conversation_id = $1 AND zone_id = $2 AND kind = 'message'
     ORDER BY seq DESC LIMIT $3`,
    [conversationId, zoneId, messageWindow],
  )

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
       AND kind IN ('plan', 'approval', 'rejection', 'execution', 'error')
     ORDER BY seq DESC LIMIT $3`,
    [conversationId, zoneId, FACTS_TURN_LIMIT],
  )
  return summarizeHistory(rows)
}

type AppendOutcome = { ok: true; turn: Record<string, unknown> } | { ok: false; reason: 'not_found' | 'archived' }

// Appends a single turn in its own transaction: locks the conversation, confirms it
// is active, allocates the gapless seq, and writes. Used by the message orchestrator
// to record the operator's message and the agent's response as distinct, ordered
// turns without holding a transaction open across a model call.
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
    const { rows: conv } = await client.query<{ status: string; next_seq: number }>(
      `SELECT status, next_seq FROM operator_conversations
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
    return { ok: true as const, turn }
  })
}

export interface OperatorRoutesOptions {
  enabled: boolean
  allowedCapabilities?: string[] | null
  systemZones?: string[] | null
  aiProviders?: ProviderConfig[]
  // Signs the Operator's own admin audit records into the same tamper-evident chain as
  // every other control-plane change. Null leaves the chain hash-linked but unsigned,
  // matching the rest of the audit log when no key is configured.
  auditHmacKey?: Buffer | null
  // Internal-only: the Operator's reserved caracal.sys control identity used to execute
  // through the governed control plane. Null leaves governed execution unconfigured. Never
  // an end-user surface; supplied by sealed platform config.
  controlIdentity?: OperatorControlIdentity | null
  // Injectable transport so the gateway path can be exercised in tests without a
  // live AI backend; defaults to the platform fetch in production.
  fetchImpl?: typeof fetch
}

export const operatorRoutes: FastifyPluginAsync<OperatorRoutesOptions> = async (fastify, opts) => {
  // Resolve the Operator's reserved, least-privilege identity once. A
  // misconfigured grant throws here, so the service fails closed at startup
  // rather than running with an unintended authority.
  const authority: OperatorAuthority = buildOperatorAuthority({
    allowedCapabilities: opts.allowedCapabilities,
    systemZones: opts.systemZones,
  })

  // The optional AI gateway. With no provider configured it reports disabled and
  // performs no work, so the AI tier costs nothing until an operator brings a key.
  const gateway: Gateway = createGateway(opts.aiProviders ?? [], opts.fetchImpl)

  // Always cheap and always present so the console can render a precise enabled/disabled
  // state without inferring it from a missing route. When enabled it also exposes the
  // Operator's reserved principal and the capabilities it is permitted to execute, so
  // the least-privilege boundary is visible rather than implicit.
  fastify.get('/operator/status', async () => {
    if (!opts.enabled) return { enabled: false }
    return {
      enabled: true,
      principal: authority.principal,
      allowed_capabilities: [...authority.allowedCapabilities].sort(),
      // Whether the Operator's governed-execution identity is provisioned, and the single
      // zone it governs. Surfaced so an operator can confirm the dogfooding identity is
      // configured without inspecting secrets; the credential itself is never exposed.
      governed_execution: opts.controlIdentity ? { configured: true, zone_id: opts.controlIdentity.zoneId } : { configured: false },
    }
  })

  // When the Operator is disabled it registers no functional routes, so it holds no
  // catalog, runs no queries, and consumes nothing beyond the status probe above.
  if (!opts.enabled) return

  // Reports which AI providers are configured, in failover order, never exposing
  // keys. The console uses this to show whether the AI tier is available.
  fastify.get('/operator/ai/status', async () => {
    return gateway.status()
  })

  // Verifies AI connectivity by sending a minimal completion through the failover
  // chain. This is the one place a real provider call is made on an explicit operator
  // action, so an operator can confirm their bring-your-own-key configuration works.
  fastify.post('/operator/ai/check', async (_req, reply) => {
    const started = Date.now()
    try {
      const result = await gateway.complete(
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
    const { rows } = await fastify.db.query(
      `INSERT INTO operator_conversations (id, zone_id, title, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING ${CONVERSATION_SELECT}`,
      [id, params.zoneId, parsed.data.title, req.actor.id],
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
    if (body.title === undefined && body.status === undefined) {
      return reply.code(400).send({ error: 'no_fields' })
    }
    const { rows } = await fastify.db.query(
      `UPDATE operator_conversations
       SET title = COALESCE($3, title),
           status = COALESCE($4, status),
           archived_at = CASE
             WHEN $4 = 'archived' THEN now()
             WHEN $4 = 'active' THEN NULL
             ELSE archived_at
           END,
           updated_at = now()
       WHERE id = $1 AND zone_id = $2
       RETURNING ${CONVERSATION_SELECT}`,
      [params.id, params.zoneId, body.title ?? null, body.status ?? null],
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

    const state = await loadConversationState(fastify.db, params.id, params.zoneId, query.data.message_window)
    const facts = await loadConversationFacts(fastify.db, params.id, params.zoneId)

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
      const { rows: conv } = await client.query<{ status: string; next_seq: number }>(
        `SELECT status, next_seq FROM operator_conversations
         WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
        [params.id, params.zoneId],
      )
      if (!conv[0]) throw new TxAbort(reply.code(404).send({ error: 'conversation_not_found' }))
      if (conv[0].status !== 'active') {
        throw new TxAbort(reply.code(409).send({ error: 'conversation_archived' }))
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
      const { rows: conv } = await client.query<{ status: string; next_seq: number }>(
        `SELECT status, next_seq FROM operator_conversations
         WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
        [params.id, params.zoneId],
      )
      if (!conv[0]) throw new TxAbort(reply.code(404).send({ error: 'conversation_not_found' }))
      if (conv[0].status !== 'active') {
        throw new TxAbort(reply.code(409).send({ error: 'conversation_archived' }))
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

    try {
      return await withTransaction(fastify.db, async (client) => {
        const { rows: conv } = await client.query<{ status: string; next_seq: number }>(
          `SELECT status, next_seq FROM operator_conversations
           WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
          [params.id, params.zoneId],
        )
        if (!conv[0]) throw new TxAbort(reply.code(404).send({ error: 'conversation_not_found' }))
        if (conv[0].status !== 'active') {
          throw new TxAbort(reply.code(409).send({ error: 'conversation_archived' }))
        }

        const { rows: planRows } = await client.query<{ content: PlanTurnContent }>(
          `SELECT content FROM operator_turns
           WHERE conversation_id = $1 AND zone_id = $2 AND seq = $3 AND kind = 'plan'`,
          [params.id, params.zoneId, planSeq],
        )
        if (!planRows[0]) throw new TxAbort(reply.code(404).send({ error: 'plan_not_found' }))

        const { rows: decision } = await client.query<{ kind: string }>(
          `SELECT kind FROM operator_turns
           WHERE conversation_id = $1 AND zone_id = $2
             AND kind IN ('approval', 'rejection')
             AND (content->>'plan_seq')::bigint = $3
           LIMIT 1`,
          [params.id, params.zoneId, planSeq],
        )
        if (!decision[0]) throw new TxAbort(reply.code(409).send({ error: 'plan_not_approved' }))
        if (decision[0].kind === 'rejection') {
          throw new TxAbort(reply.code(409).send({ error: 'plan_rejected' }))
        }

        const { rows: executed } = await client.query(
          `SELECT 1 FROM operator_turns
           WHERE conversation_id = $1 AND zone_id = $2 AND kind = 'execution'
             AND (content->>'plan_seq')::bigint = $3
           LIMIT 1`,
          [params.id, params.zoneId, planSeq],
        )
        if (executed[0]) throw new TxAbort(reply.code(409).send({ error: 'plan_already_executed' }))

        const steps = planRows[0].content.steps.map((step) => ({
          id: step.id,
          capability: step.capability,
          args: step.args ?? {},
        }))

        // Re-validate against the live catalog before applying anything, so a plan
        // never half-applies.
        const revalidation = validateProposedPlan({ summary: planRows[0].content.summary, steps })
        if (!revalidation.ok) {
          throw new TxAbort(reply.code(409).send({ error: 'plan_invalid', validation: revalidation }))
        }

        // Authority is the primary boundary and is checked before implementation
        // concerns: a step the Operator's least-privilege identity may not execute is
        // refused as forbidden, even if it happens to also lack a handler.
        const denials = authorizePlanSteps(authority, steps)
        if (denials.length > 0) {
          throw new TxAbort(
            reply.code(403).send({
              error: 'capability_forbidden',
              principal: authority.principal,
              steps: denials,
            }),
          )
        }

        // Every authorized step must also have an execution handler.
        const unsupported = unsupportedSteps(steps)
        if (unsupported.length > 0) {
          throw new TxAbort(
            reply.code(422).send({
              error: 'capability_not_executable',
              steps: unsupported.map((s) => ({ step_id: s.id, capability: s.capability })),
            }),
          )
        }

        // Re-preview against current state; a step that is now blocked stops the
        // whole plan before any write.
        const preview = await previewPlan(client, params.zoneId, {
          summary: planRows[0].content.summary,
          steps,
        })
        if (!preview.ok) {
          throw new TxAbort(reply.code(409).send({ error: 'plan_blocked', preview }))
        }

        // A create step whose target now already exists would duplicate it, so the plan
        // is refused rather than applied. This closes the window between preview and
        // approval: the object may have been created in the meantime, and re-running the
        // plan must never silently create a second one.
        const existing = preview.steps.filter((step) => step.effect === 'exists')
        if (existing.length > 0) {
          throw new TxAbort(
            reply.code(409).send({
              error: 'plan_already_satisfied',
              steps: existing.map((step) => ({ step_id: step.id, capability: step.capability, detail: step.detail })),
            }),
          )
        }

        const applied = await applyPlanSteps(client, params.zoneId, steps)

        let seq = conv[0].next_seq
        const turns = []
        for (const step of applied) {
          const turn = await writeTurnLocked(client, {
            conversationId: params.id,
            zoneId: params.zoneId,
            seq,
            role: 'operator',
            kind: 'execution',
            // executed_by records the reserved Operator principal that applied the
            // change, distinct from the human approver recorded in the admin audit log.
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

          // Record the change in Caracal's own admin audit log, per entity, through the
          // same tamper-evident primitive every manual control-plane mutation uses. The
          // human who approved the plan is the authorizing actor; the Operator principal
          // that applied it is carried in the payload, so the Operator dogfoods Caracal's
          // audit exactly as a user-driven change would — no change bypasses the ledger.
          if (step.audit) {
            await insertAdminAuditRecord(
              client,
              {
                requestId: req.id,
                actorId: req.actor.id,
                actorName: req.actor.name ?? null,
                actorScope: req.actor.scope ?? null,
                action: `operator.execute:${step.capability}`,
                method: 'POST',
                path: pathOnly(req.url),
                zoneId: step.audit.zoneId,
                entityType: step.audit.entityType,
                entityId: step.audit.entityId,
                statusCode: 201,
                payloadJson: {
                  executed_by: authority.principal,
                  plan_seq: planSeq,
                  step_id: step.id,
                  capability: step.capability,
                },
              },
              opts.auditHmacKey ?? null,
            )
          }
        }

        // One-time outputs (such as issued client secrets) are returned here only and
        // are never written to the ledger.
        const outputs: Record<string, Record<string, unknown>> = {}
        for (const step of applied) {
          if (step.output) outputs[step.id] = step.output
        }
        return reply.code(201).send({ ok: true, plan_seq: planSeq, executed_by: authority.principal, executed: turns, outputs })
      })
    } catch (err) {
      if (!(err instanceof StepExecutionError)) throw err
      // The transaction rolled back, so no step persisted. Record a single error turn
      // describing the failed step; the plan stays approved and may be retried.
      await withTransaction(fastify.db, async (client) => {
        const { rows: conv } = await client.query<{ status: string; next_seq: number }>(
          `SELECT status, next_seq FROM operator_conversations
           WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
          [params.id, params.zoneId],
        )
        if (!conv[0] || conv[0].status !== 'active') return
        await writeTurnLocked(client, {
          conversationId: params.id,
          zoneId: params.zoneId,
          seq: conv[0].next_seq,
          role: 'system',
          kind: 'error',
          contentJson: JSON.stringify({
            message: `Step ${err.stepId} (${err.capability}) failed: ${err.message}`,
          }),
          actorId: req.actor.id,
        })
      })
      return reply.code(422).send({ error: 'execution_failed', step_id: err.stepId })
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
    const status = gateway.status()
    if (!status.enabled) return reply.code(409).send({ error: 'ai_unavailable' })

    // A model preference must name an available provider; an unknown or unavailable id is
    // rejected rather than silently ignored, so the console and gateway never disagree.
    const preference = parsed.data.provider ?? null
    if (preference && !status.providers.some((p) => p.id === preference && p.available)) {
      return reply.code(400).send({ error: 'invalid_provider' })
    }

    // Record the operator's message first, so it is in the ledger regardless of how
    // the agents respond, and so the agents reason over a context that includes it.
    const userTurn = await appendTurnTx(
      fastify.db,
      params.id,
      params.zoneId,
      'user',
      'message',
      JSON.stringify({ text: parsed.data.message }),
      req.actor.id,
    )
    if (!userTurn.ok) {
      return reply
        .code(userTurn.reason === 'archived' ? 409 : 404)
        .send({ error: userTurn.reason === 'archived' ? 'conversation_archived' : 'conversation_not_found' })
    }

    const state = await loadConversationState(fastify.db, params.id, params.zoneId, MESSAGE_CONTEXT_WINDOW)
    const facts = await loadConversationFacts(fastify.db, params.id, params.zoneId)
    const context: AgentContext = { facts, state }

    // Track the real token usage of every completion made while answering this one
    // message, and report it alongside the model that answered and its context window so
    // the console can show genuine usage. preferProvider routes to the chosen model while
    // the context the agents reason over stays the full conversation history.
    const tracked = withUsage(preferProvider(gateway, preference))
    const effective = status.providers.find((p) => p.id === preference && p.available) ?? status.providers.find((p) => p.available) ?? null
    const meta = () => {
      const usage = tracked.usage()
      return {
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens,
        },
        model: effective?.model ?? null,
        provider: effective?.id ?? null,
        max_tokens: effective?.contextWindow ?? 0,
      }
    }

    try {
      const route = await runRouter(tracked.gateway, parsed.data.message)
      const intent = route.ok ? route.value : 'explain'

      if (intent === 'plan') {
        const planned = await runPlanner(tracked.gateway, parsed.data.message, context)
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
          return reply.code(200).send({
            intent: 'plan',
            ok: false,
            error: 'no_plan',
            message,
            turn: turn.ok ? turn.turn : null,
            ...meta(),
          })
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
          return reply.code(200).send({
            intent: 'plan',
            ok: false,
            error: 'plan_invalid',
            validation,
            turn: turn.ok ? turn.turn : null,
            ...meta(),
          })
        }

        const preview = await previewPlan(fastify.db, params.zoneId, planned.value)
        const turn = await appendTurnTx(
          fastify.db,
          params.id,
          params.zoneId,
          'operator',
          'plan',
          buildPlanContentJson(planned.value.summary, validation),
          req.actor.id,
        )
        if (!turn.ok) {
          return reply
            .code(turn.reason === 'archived' ? 409 : 404)
            .send({ error: turn.reason === 'archived' ? 'conversation_archived' : 'conversation_not_found' })
        }
        return reply.code(201).send({ intent: 'plan', ok: true, turn: turn.turn, validation, preview, ...meta() })
      }

      const explained = await runExplainer(tracked.gateway, parsed.data.message, context)
      const answer = explained.ok ? explained.value : { text: 'I could not produce an explanation.' }
      const noteContent: Record<string, unknown> = { text: answer.text }
      if (answer.reasoning) noteContent.reasoning = answer.reasoning
      const turn = await appendTurnTx(fastify.db, params.id, params.zoneId, 'operator', 'note', JSON.stringify(noteContent), req.actor.id)
      return reply.code(201).send({
        intent: 'explain',
        ok: explained.ok,
        text: answer.text,
        reasoning: answer.reasoning,
        turn: turn.ok ? turn.turn : null,
        ...meta(),
      })
    } catch (err) {
      if (err instanceof GatewayUnavailableError) return reply.code(409).send({ error: 'ai_unavailable' })
      if (err instanceof GatewayError) return reply.code(502).send({ error: 'ai_unreachable', attempts: err.attempts })
      throw err
    }
  })
}
