// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone audit record for credential reveals, enqueued through the transactional outbox.

import { createHmac } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import type { FastifyRequest } from 'fastify'
import { AUDIT_STREAM } from '@caracalai/core'
import { enqueueOutbox, type ClientLike } from './outbox.js'

// A reveal responds with the credential if and only if this audit event is durably
// queued for the audit stream: the enqueue runs in its own transaction before the
// secret leaves the API, so an unauditable reveal fails instead of going unrecorded.
// The payload matches the STS wire shape so the zone timeline reads uniformly.
export async function enqueueCredentialRevealAudit(
  client: ClientLike,
  hmacKey: Buffer | null,
  req: FastifyRequest,
  zoneId: string,
  metadata: Record<string, string>,
): Promise<void> {
  const data = JSON.stringify({
    id: uuidv7(),
    zone_id: zoneId,
    event_type: 'credential_revealed',
    request_id: req.id,
    decision: 'allow',
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
