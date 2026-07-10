// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit emit sink for the control surface: every invoke decision is written to caracal.audit.events as a control.invoke event.

import { createHmac, randomBytes } from 'node:crypto'
import { AUDIT_STREAM, type Logger } from '@caracalai/core'
import { enqueueOutbox, type ClientLike } from '../outbox.js'
import type { RedisClient } from '../redis.js'

export interface AuditEvent {
  at: Date
  zoneId?: string
  clientId?: string
  subject: string
  jti: string
  command?: string
  subcommand?: string
  decision: 'allow' | 'deny'
  reason?: string
  requestId: string
  idempotencyKey?: string
  // A subject-asserted attribution for the authority the caller acted on behalf of. Recorded
  // verbatim as audit metadata so an approval-gated change is reconstructable from the
  // tamper-evident chain; never an authorization input.
  authorizedBy?: string
}

export interface EventSink {
  emit(ev: AuditEvent): Promise<void>
}

// Emits control audit events with a durability guarantee: the event reaches the audit stream
// directly, or it is durably enqueued in the transactional outbox for the dispatcher to drain
// to the same stream. Only when both the stream and the outbox are unreachable does emit
// throw, so the invoke handler can refuse to report success for an unauditable operation
// instead of silently losing the governance record.
export class RedisSink implements EventSink {
  constructor(
    private readonly client: RedisClient,
    private readonly hmacKey: Buffer | undefined,
    private readonly log: Logger,
    private readonly streamMaxLen: number = 100_000,
    private readonly outbox?: ClientLike,
  ) {}

  async emit(ev: AuditEvent): Promise<void> {
    const values = buildAuditPayload(ev, this.hmacKey)
    try {
      const args: string[] = []
      for (const [k, v] of Object.entries(values)) args.push(k, v)
      await this.client.xadd(AUDIT_STREAM, 'MAXLEN', '~', String(this.streamMaxLen), '*', ...args)
    } catch (err) {
      if (!this.outbox) {
        this.log.error('control audit emit failed with no durable fallback', { err: String(err), request_id: ev.requestId })
        throw new AuditUnavailableError(ev.requestId)
      }
      try {
        await enqueueOutbox(this.outbox, { streamName: AUDIT_STREAM, payload: values, requestId: ev.requestId })
        this.log.warn('control audit stream unreachable; event durably enqueued to outbox', {
          err: String(err),
          request_id: ev.requestId,
        })
      } catch (outboxErr) {
        this.log.error('control audit emit failed on both stream and outbox', {
          err: String(err),
          outbox_err: String(outboxErr),
          request_id: ev.requestId,
        })
        throw new AuditUnavailableError(ev.requestId)
      }
    }
  }
}

// Raised when an audit event could not be durably recorded anywhere. The invoke handler
// treats it as fail-closed: an allowed operation whose audit is lost is reported as an
// error, never as success.
export class AuditUnavailableError extends Error {
  constructor(requestId: string) {
    super(`audit record could not be durably recorded (request ${requestId})`)
    this.name = 'AuditUnavailableError'
  }
}

export function newRequestId(): string {
  return randomBytes(16).toString('hex')
}

// Postgres rejects NUL bytes in text and jsonb values, so caller-influenced strings are
// sanitized before they enter a payload that must persist through the outbox or the audit
// store; the HMAC signs the sanitized form.
function stripNul(value: string): string {
  return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value
}

export function buildAuditPayload(ev: AuditEvent, key: Buffer | undefined): Record<string, string> {
  const id = ev.requestId || newRequestId()
  const zoneId = stripNul(ev.zoneId || 'unknown')
  const metadata = JSON.stringify({
    subject: stripNul(ev.subject),
    jti: stripNul(ev.jti),
    client_id: stripNul(ev.clientId ?? ''),
    command: stripNul(ev.command ?? ''),
    subcommand: stripNul(ev.subcommand ?? ''),
    reason: stripNul(ev.reason ?? ''),
    idempotency_key: stripNul(ev.idempotencyKey ?? ''),
    authorized_by: stripNul(ev.authorizedBy ?? ''),
  })
  const occurredAt = (ev.at ?? new Date()).toISOString()
  const event = {
    id,
    zone_id: zoneId,
    event_type: 'control.invoke',
    request_id: ev.requestId,
    decision: ev.decision,
    evaluation_status: 'complete',
    determining_policies_json: [],
    diagnostics_json: [],
    metadata_json: JSON.parse(metadata),
    occurred_at: occurredAt,
  }
  const data = JSON.stringify(event)
  const values: Record<string, string> = { id, data }
  if (key && key.length > 0) {
    values.sig = createHmac('sha256', key).update(data).digest('hex')
  }
  return values
}
