// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Internal admin audit persistence utilities for Caracal services.

import { v7 as uuidv7 } from 'uuid'

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
  query(sql: string, params: (string | number | Record<string, unknown> | null)[]): Promise<unknown>
}

export async function insertAdminAuditRecord(db: Queryable, rec: AdminAuditRecord): Promise<void> {
  await db.query(
    `INSERT INTO admin_audit_events
     (id, request_id, actor_id, actor_name, actor_scope, action, method, path,
      zone_id, entity_type, entity_id, status_code, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [
      uuidv7(),
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
    ],
  )
}
