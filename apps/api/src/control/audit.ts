// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit emit sink for the control surface: every invoke decision is written to caracal.audit.events as a control.invoke event.

import { createHmac, randomBytes } from 'node:crypto'
import { AUDIT_STREAM, type Logger } from '@caracalai/core'
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
}

export interface EventSink {
  emit(ev: AuditEvent): Promise<void>
}

export class RedisSink implements EventSink {
  constructor(
    private readonly client: RedisClient,
    private readonly hmacKey: Buffer | undefined,
    private readonly log: Logger,
    private readonly streamMaxLen: number = 100_000,
  ) {}

  async emit(ev: AuditEvent): Promise<void> {
    const values = buildAuditPayload(ev, this.hmacKey)
    try {
      const args: string[] = []
      for (const [k, v] of Object.entries(values)) args.push(k, v)
      await this.client.xadd(AUDIT_STREAM, 'MAXLEN', '~', String(this.streamMaxLen), '*', ...args)
    } catch (err) {
      this.log.error('control audit emit failed', { err: String(err), request_id: ev.requestId })
    }
  }
}

export function newRequestId(): string {
  return randomBytes(16).toString('hex')
}

export function buildAuditPayload(ev: AuditEvent, key: Buffer | undefined): Record<string, string> {
  const id = ev.requestId || newRequestId()
  const zoneId = ev.zoneId || 'unknown'
  const metadata = JSON.stringify({
    subject: ev.subject,
    jti: ev.jti,
    client_id: ev.clientId ?? '',
    command: ev.command ?? '',
    subcommand: ev.subcommand ?? '',
    reason: ev.reason ?? '',
    idempotency_key: ev.idempotencyKey ?? '',
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
