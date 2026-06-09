// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Internal admin audit persistence utilities for Caracal services.

import { v7 as uuidv7 } from 'uuid'
import { createHash, createHmac } from 'node:crypto'

export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface AdminAuditRecord {
  requestId: string
  actorId: string | null
  actorName: string | null
  actorScope: string | null
  action: string
  method: string
  path: string
  zoneId: string | null
  entityType: string | null
  entityId: string | null
  statusCode: number
  payloadJson?: Record<string, unknown> | null
}

export interface Queryable {
  query(sql: string, params: (string | number | Record<string, unknown> | null)[]): Promise<{ rows: unknown[] }>
}

const GLOBAL_CHAIN_KEY = '\u0000admin-global'

function contentHash(id: string, occurredAt: string, rec: AdminAuditRecord): string {
  const h = createHash('sha256')
  const write = (s: string | null): void => {
    h.update(s ?? '')
    h.update('\u001f')
  }
  write(id)
  write(rec.requestId)
  write(rec.actorId)
  write(rec.actorName)
  write(rec.actorScope)
  write(rec.action)
  write(rec.method)
  write(rec.path)
  write(rec.zoneId)
  write(rec.entityType)
  write(rec.entityId)
  write(String(rec.statusCode))
  write(rec.payloadJson ? JSON.stringify(rec.payloadJson) : '')
  write(occurredAt)
  return h.digest('hex')
}

function chainHmac(key: Buffer | null, contentSha: string, prevSha: string): string {
  if (!key || key.length === 0) return ''
  const mac = createHmac('sha256', key)
  mac.update(contentSha)
  mac.update('|')
  mac.update(prevSha)
  return mac.digest('hex')
}

interface ChainHead {
  content_sha256: string
  chain_seq: string | number
}

// Inserts one admin audit record into a per-zone tamper-evident hash chain. The
// caller MUST run this inside a transaction so the advisory lock, chain-head
// read, and insert are atomic. hmacKey signs each link; when absent the chain is
// still hash-linked but unsigned.
export async function insertAdminAuditRecord(
  tx: Queryable,
  rec: AdminAuditRecord,
  hmacKey: Buffer | null = null,
): Promise<void> {
  const id = uuidv7()
  const occurredAt = new Date().toISOString()
  const chainKey = rec.zoneId ?? GLOBAL_CHAIN_KEY

  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [chainKey])

  const head = await tx.query(
    `SELECT COALESCE(content_sha256, '') AS content_sha256, COALESCE(chain_seq, 0) AS chain_seq
     FROM admin_audit_events
     WHERE zone_id IS NOT DISTINCT FROM $1
     ORDER BY chain_seq DESC NULLS LAST
     LIMIT 1`,
    [rec.zoneId],
  )
  const prev = (head.rows[0] as ChainHead | undefined) ?? { content_sha256: '', chain_seq: 0 }
  const prevSha = prev.content_sha256
  const nextSeq = Number(prev.chain_seq) + 1

  const contentSha = contentHash(id, occurredAt, rec)
  const hmac = chainHmac(hmacKey, contentSha, prevSha)

  await tx.query(
    `INSERT INTO admin_audit_events
     (id, request_id, actor_id, actor_name, actor_scope, action, method, path,
      zone_id, entity_type, entity_id, status_code, payload_json, occurred_at,
      content_sha256, prev_content_sha256, chain_hmac, chain_seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14,
             $15, $16, $17, $18)`,
    [
      id,
      rec.requestId,
      rec.actorId,
      rec.actorName,
      rec.actorScope,
      rec.action,
      rec.method,
      rec.path,
      rec.zoneId,
      rec.entityType,
      rec.entityId,
      rec.statusCode,
      rec.payloadJson ?? null,
      occurredAt,
      contentSha,
      prevSha === '' ? null : prevSha,
      hmac === '' ? null : hmac,
      nextSeq,
    ],
  )
}
