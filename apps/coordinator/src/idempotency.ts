// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Durable idempotency receipts for Coordinator mutations.

import { createHash, createHmac } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import type { Queryable } from './outbox.js'

export const IDEMPOTENCY_KEY_MAX_BYTES = 255

export const idempotencyStats = {
  created: 0,
  replayed: 0,
  conflicts: 0,
  invalid: 0,
  expired: 0,
}

interface ReceiptRow {
  request_digest: Buffer
  response_status: number
  response_json: unknown
  resource_id: string | null
}

export type IdempotencyStart =
  | { outcome: 'new'; keyDigest: Buffer; requestDigest: Buffer }
  | { outcome: 'replayed'; status: number; response: unknown; resourceId: string | null }
  | { outcome: 'conflict' }
  | { outcome: 'limit' }

export function parseIdempotencyKey(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  if (Array.isArray(value)) {
    idempotencyStats.invalid += 1
    throw new IdempotencyKeyError('idempotency_key_multiple', 'Idempotency-Key must be supplied exactly once')
  }
  if (value.length === 0 || value !== value.trim()) {
    idempotencyStats.invalid += 1
    throw new IdempotencyKeyError(
      'idempotency_key_invalid',
      'Idempotency-Key must be non-empty and must not contain surrounding whitespace',
    )
  }
  if (Buffer.byteLength(value, 'utf8') > IDEMPOTENCY_KEY_MAX_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
    idempotencyStats.invalid += 1
    throw new IdempotencyKeyError(
      'idempotency_key_invalid',
      `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_BYTES} UTF-8 bytes and contain no control characters`,
    )
  }
  return value
}

export class IdempotencyKeyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'IdempotencyKeyError'
  }
}

export function requestDigest(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value)).digest()
}

export function keyDigest(key: string, hmacKey: Buffer): Buffer {
  return createHmac('sha256', hmacKey).update('caracal:coordinator:idempotency:v1\0').update(key).digest()
}

function lockDigest(key: string): string {
  return createHash('sha256').update('caracal:coordinator:idempotency-lock:v1\0').update(key).digest('hex')
}

export async function startIdempotency(
  db: Queryable,
  input: {
    operation: string
    zoneId: string
    scopeId: string
    key: string
    request: unknown
    hmacKeys: readonly Buffer[]
    maxReceiptsPerScope: number
  },
): Promise<IdempotencyStart> {
  const keyHashes = input.hmacKeys.map((key) => keyDigest(input.key, key))
  const keyHash = keyHashes[0]
  const previousKeyHash = keyHashes[1] ?? keyHash
  const bodyHash = requestDigest(input.request)
  const lockName = `${input.operation}:${input.zoneId}:${input.scopeId}:${lockDigest(input.key)}`
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [lockName])
  const expired = await db.query(
    `DELETE FROM coordinator_idempotency_receipts
     WHERE operation = $1 AND zone_id = $2 AND scope_id = $3 AND key_digest IN ($4, $5)
       AND expires_at <= now()`,
    [input.operation, input.zoneId, input.scopeId, keyHash, previousKeyHash],
  )
  idempotencyStats.expired += expired.rowCount ?? 0
  const { rows } = await db.query<ReceiptRow>(
    `SELECT request_digest, response_status, response_json, resource_id
     FROM coordinator_idempotency_receipts
     WHERE operation = $1 AND zone_id = $2 AND scope_id = $3 AND key_digest IN ($4, $5)
       AND expires_at > now()`,
    [input.operation, input.zoneId, input.scopeId, keyHash, previousKeyHash],
  )
  if (!rows[0]) {
    const { rows: counts } = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n
       FROM coordinator_idempotency_receipts
       WHERE operation = $1 AND zone_id = $2 AND scope_id = $3 AND expires_at > now()`,
      [input.operation, input.zoneId, input.scopeId],
    )
    if (Number(counts[0]?.n ?? 0) >= input.maxReceiptsPerScope) return { outcome: 'limit' }
    return { outcome: 'new', keyDigest: keyHash, requestDigest: bodyHash }
  }
  if (!rows[0].request_digest.equals(bodyHash)) {
    idempotencyStats.conflicts += 1
    return { outcome: 'conflict' }
  }
  idempotencyStats.replayed += 1
  return {
    outcome: 'replayed',
    status: rows[0].response_status,
    response: rows[0].response_json,
    resourceId: rows[0].resource_id,
  }
}

export async function completeIdempotency(
  db: Queryable,
  input: {
    operation: string
    zoneId: string
    scopeId: string
    keyDigest: Buffer
    requestDigest: Buffer
    resourceType: string
    resourceId: string
    responseStatus: number
    response: unknown
    retentionSeconds: number
  },
): Promise<void> {
  await db.query(
    `INSERT INTO coordinator_idempotency_receipts
       (id, operation, zone_id, scope_id, key_digest, request_digest,
        resource_type, resource_id, response_status, response_json, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,
             now() + ($11::int * interval '1 second'))`,
    [
      uuidv7(),
      input.operation,
      input.zoneId,
      input.scopeId,
      input.keyDigest,
      input.requestDigest,
      input.resourceType,
      input.resourceId,
      input.responseStatus,
      JSON.stringify(input.response),
      input.retentionSeconds,
    ],
  )
  idempotencyStats.created += 1
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('idempotency request contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  throw new TypeError(`idempotency request contains unsupported ${typeof value}`)
}
