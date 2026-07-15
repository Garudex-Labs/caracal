// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Human-approval hold endpoints: inspection and operator-plane approve/reject decisions.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { AUDIT_STREAM } from '@caracalai/core'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { appendKeysetCondition, listPage, parseListPagination } from './list-pagination.js'
import { withTransaction, TxAbort } from '../db.js'
import { enqueueOutbox, type ClientLike } from '../outbox.js'

// The reason bound matches the STS decision endpoint, so a rationale accepted on one plane is
// never rejected on the other.
const REASON_MAX_LENGTH = 500

const DecisionBody = z.object({ reason: z.string().max(REASON_MAX_LENGTH).optional() })

// Server-side list filters. Each state maps to the exact column predicates behind the
// derived-state CASE, so a filtered list and a row's reported state can never disagree.
const ListFilters = z.object({
  state: z.enum(['pending', 'approved', 'rejected', 'expired', 'consumed']).optional(),
  tier: z.string().min(1).max(64).optional(),
  principal: z.string().min(1).max(128).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
})

const STATE_PREDICATES: Record<string, string> = {
  pending: 'consumed_at IS NULL AND rejected_at IS NULL AND satisfied_at IS NULL AND expires_at > now()',
  approved: 'consumed_at IS NULL AND rejected_at IS NULL AND satisfied_at IS NOT NULL AND expires_at > now()',
  rejected: 'consumed_at IS NULL AND rejected_at IS NOT NULL',
  expired: 'consumed_at IS NULL AND rejected_at IS NULL AND expires_at <= now()',
  consumed: 'consumed_at IS NOT NULL',
}

// Every read returns the full approval fact plus a derived lifecycle state. The precedence
// mirrors the STS exactly - consumed and rejected are terminal and outrank expiry, an approved
// hold past its window reads expired - so both planes always report the same state for the same
// row. The binding is the canonical resource+scope hash the agent printed alongside the
// challenge id, exposed so an approver can cross-check that the hold they see is the hold the
// agent asked about. The prior_* counts are the recent history of the same binding in this
// zone: the challenge store retains terminal rows for a day, so they honestly answer "has this
// exact authority been decided recently?" without reaching into the audit stream.
const CHALLENGE_COLUMNS = `id, zone_id, session_id, principal_id, application_id, challenge_type AS approval_type,
       tier, approver_class, privacy_mode, subject_anchor, encode(resource_set_hash, 'hex') AS binding,
       metadata_json, decision_reason, created_at, expires_at,
       satisfied_at, rejected_at, consumed_at, approver_subject_id,
       (SELECT COUNT(*)::int FROM step_up_challenges p
         WHERE p.zone_id = step_up_challenges.zone_id
           AND p.resource_set_hash = step_up_challenges.resource_set_hash
           AND p.id <> step_up_challenges.id AND p.satisfied_at IS NOT NULL) AS prior_approved,
       (SELECT COUNT(*)::int FROM step_up_challenges p
         WHERE p.zone_id = step_up_challenges.zone_id
           AND p.resource_set_hash = step_up_challenges.resource_set_hash
           AND p.id <> step_up_challenges.id AND p.rejected_at IS NOT NULL) AS prior_rejected,
       CASE
         WHEN consumed_at IS NOT NULL THEN 'consumed'
         WHEN rejected_at IS NOT NULL THEN 'rejected'
         WHEN expires_at <= now() THEN 'expired'
         WHEN satisfied_at IS NOT NULL THEN 'approved'
         ELSE 'pending'
       END AS state`

interface DecidedRow {
  id: string
  session_id: string
  application_id: string | null
  tier: string | null
  approver_class: string
  privacy_mode: string
  subject_anchor: string | null
  binding: string
  metadata_json: Record<string, unknown> | null
  satisfied_at: string | null
  rejected_at: string | null
  decision_reason: string | null
  approver_subject_id: string
}

// The identity recorded as the deciding approver, always a stable id: a console decision is
// attributed by the verified account's profile id behind the BFF assertion; a direct admin or
// automation call is attributed to the credential itself. Approver identities are recorded
// verbatim regardless of the hold's privacy mode: privacy modes shield an application's end
// users on the subject plane, while zone operators act under full admin accountability.
function approverId(req: FastifyRequest): string {
  const account = req.account
  if (account) return `console:${account.id}`
  return `admin:${req.actor.id}`
}

// The zone audit record of an operator-plane decision, enqueued through the transactional
// outbox inside the decision's own transaction: the decision commits if and only if its audit
// event is durably queued for the audit stream. The payload is the same wire shape the STS
// emits for subject-plane decisions, so the zone timeline reads uniformly across both planes.
async function enqueueDecisionAudit(
  client: ClientLike,
  hmacKey: Buffer | null,
  req: FastifyRequest,
  zoneId: string,
  decision: 'approved' | 'rejected',
  row: DecidedRow,
): Promise<void> {
  const metadata: Record<string, unknown> = {
    challenge_id: row.id,
    tier: row.tier ?? '',
    approver_class: row.approver_class,
    privacy_mode: row.privacy_mode,
    binding: row.binding,
    session_id: row.session_id,
    approver_plane: 'operator',
    approver_subject_id: row.approver_subject_id,
  }
  if (row.application_id) metadata.application_id = row.application_id
  if (row.subject_anchor) metadata.subject_anchor = row.subject_anchor
  if (row.decision_reason) metadata.reason = row.decision_reason
  // The requesting agent's business labels ride the decision event so the operator plane records
  // the same case and settlement context the STS emits on issue and consume.
  const agentLabels = row.metadata_json?.agent_labels
  if (Array.isArray(agentLabels)) metadata.agent_labels = agentLabels
  const data = JSON.stringify({
    id: uuidv7(),
    zone_id: zoneId,
    event_type: 'step_up_decided',
    request_id: req.id,
    decision,
    evaluation_status: 'complete',
    determining_policies_json: [],
    diagnostics_json: [],
    metadata_json: metadata,
    occurred_at: new Date().toISOString(),
  })
  const payload: Record<string, string> = { id: req.id, data }
  if (hmacKey && hmacKey.length > 0) {
    payload.sig = createHmac('sha256', hmacKey).update(data).digest('hex')
  }
  await enqueueOutbox(client, { streamName: AUDIT_STREAM, payload, requestId: req.id })
}

export const approvalsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/approvals', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const filters = ListFilters.safeParse(req.query ?? {})
    if (!filters.success) return reply.code(400).send({ error: 'invalid_query' })
    const conds = ['zone_id = $1']
    const values: unknown[] = [params.zoneId]
    if (filters.data.state) conds.push(STATE_PREDICATES[filters.data.state])
    if (filters.data.tier) {
      values.push(filters.data.tier)
      conds.push(`tier = $${values.length}`)
    }
    if (filters.data.principal) {
      values.push(filters.data.principal)
      conds.push(`principal_id = $${values.length}`)
    }
    if (filters.data.since) {
      values.push(filters.data.since)
      conds.push(`created_at >= $${values.length}`)
    }
    if (filters.data.until) {
      values.push(filters.data.until)
      conds.push(`created_at <= $${values.length}`)
    }
    const keyset = appendKeysetCondition({ conds, values }, page)
    const { rows } = await fastify.db.query(
      `SELECT ${CHALLENGE_COLUMNS}
       FROM step_up_challenges WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    return listPage(rows, page.limit)
  })

  // One aggregate over the zone's live approval table, cheap enough to poll: the counts
  // behind navigation badges and dashboard summaries. Terminal rows age out of this table
  // on the retention sweep, so the counts reflect the actionable working set, not history.
  fastify.get('/zones/:zoneId/approvals/counts', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query<Record<string, string>>(
      `SELECT
         count(*) FILTER (WHERE ${STATE_PREDICATES.pending}) AS pending,
         count(*) FILTER (WHERE ${STATE_PREDICATES.approved}) AS approved,
         count(*) FILTER (WHERE ${STATE_PREDICATES.rejected}) AS rejected,
         count(*) FILTER (WHERE ${STATE_PREDICATES.expired}) AS expired,
         count(*) FILTER (WHERE ${STATE_PREDICATES.consumed}) AS consumed
       FROM step_up_challenges WHERE zone_id = $1`,
      [params.zoneId],
    )
    const counts = rows[0] ?? {}
    return {
      pending: Number(counts.pending ?? 0),
      approved: Number(counts.approved ?? 0),
      rejected: Number(counts.rejected ?? 0),
      expired: Number(counts.expired ?? 0),
      consumed: Number(counts.consumed ?? 0),
    }
  })

  fastify.get('/zones/:zoneId/approvals/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT ${CHALLENGE_COLUMNS}
       FROM step_up_challenges WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'approval_not_found' })
    return rows[0]
  })

  // Decides a live hold on the operator plane. The guards live in the UPDATE itself, so a
  // decision lands exactly once on exactly one live hold: it must still be pending (never
  // decided, never consumed), unexpired, and open to operators - a subject-only hold is the
  // application's promise that only its own end user may approve, and no zone credential
  // overrides that. A miss is then classified for the caller: absent, operator-forbidden, or
  // already settled with its current state.
  const decide = async (req: FastifyRequest, reply: FastifyReply, decision: 'approved' | 'rejected'): Promise<unknown> => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = DecisionBody.safeParse(req.body ?? {})
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' })
    const approver = approverId(req)
    const decidedColumn = decision === 'approved' ? 'satisfied_at' : 'rejected_at'

    return withTransaction(fastify.db, async (client) => {
      const { rows } = await client.query<DecidedRow>(
        `UPDATE step_up_challenges
         SET ${decidedColumn} = now(), approver_subject_id = $3, decision_reason = $4
         WHERE id = $1 AND zone_id = $2
           AND approver_class IN ('operator', 'any')
           AND satisfied_at IS NULL AND rejected_at IS NULL AND consumed_at IS NULL
           AND expires_at > now()
         RETURNING id, session_id, application_id, tier, approver_class, privacy_mode, subject_anchor,
                   encode(resource_set_hash, 'hex') AS binding, metadata_json,
                   satisfied_at, rejected_at, decision_reason, approver_subject_id`,
        [params.id, params.zoneId, approver, body.data.reason ?? null],
      )
      if (!rows[0]) {
        const { rows: existing } = await client.query<{ approver_class: string; state: string }>(
          `SELECT approver_class,
                  CASE
                    WHEN consumed_at IS NOT NULL THEN 'consumed'
                    WHEN rejected_at IS NOT NULL THEN 'rejected'
                    WHEN expires_at <= now() THEN 'expired'
                    WHEN satisfied_at IS NOT NULL THEN 'approved'
                    ELSE 'pending'
                  END AS state
           FROM step_up_challenges WHERE id = $1 AND zone_id = $2`,
          [params.id, params.zoneId],
        )
        if (!existing[0]) throw new TxAbort(reply.code(404).send({ error: 'approval_not_found' }))
        if (existing[0].state === 'pending' && existing[0].approver_class === 'subject') {
          throw new TxAbort(reply.code(403).send({ error: 'subject_approval_required' }))
        }
        throw new TxAbort(reply.code(409).send({ error: 'approval_not_decidable', state: existing[0].state }))
      }
      await enqueueDecisionAudit(client, fastify.cfg?.auditHmacKey ?? null, req, params.zoneId, decision, rows[0])
      // Wakes STS long-poll waiters the moment the decision commits; the channel
      // name is the contract shared with the STS notification listener.
      await client.query('SELECT pg_notify($1, $2)', ['caracal_approval_decided', params.id])
      return {
        id: rows[0].id,
        state: decision,
        satisfied_at: rows[0].satisfied_at,
        rejected_at: rows[0].rejected_at,
        approver_subject_id: rows[0].approver_subject_id,
      }
    })
  }

  fastify.post('/zones/:zoneId/approvals/:id/approve', async (req, reply) => decide(req, reply, 'approved'))

  fastify.post('/zones/:zoneId/approvals/:id/reject', async (req, reply) => decide(req, reply, 'rejected'))
}
