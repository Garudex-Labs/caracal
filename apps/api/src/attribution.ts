// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resolves the human creator and Caracal Operator co-authorship of a created object from the request's verified attribution signals.

import type { FastifyRequest } from 'fastify'
import type { Queryable } from './db.js'

// The header the in-process Control invoke hop sets so a create route can attribute an
// operator-driven object to the human the operator acted for. It rides the internal admin-token
// call the Control handler makes to the API, a hop the BFF never exposes to the browser, so a
// console client can never set it.
export const AUTHORIZED_BY_HEADER = 'x-caracal-authorized-by'
// The header the Control invoke hop sets to mark an object as created through the Caracal Operator,
// so a create route can stamp co-authorship. Same internal-only trust as the authorized-by header.
export const CREATED_VIA_HEADER = 'x-caracal-created-via'
const OPERATOR_ORIGIN = 'operator'

function headerStr(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

// The name recorded as an object's creator. The operator hop's authorized-by wins so an
// operator-created object names the human the operator acted for; then the console operator's own
// name or email from the verified assertion; then the admin credential's own name for a direct
// admin or automation call.
export function resolveCreatedBy(req: FastifyRequest): string {
  const authorized = headerStr(req.headers[AUTHORIZED_BY_HEADER])
  if (authorized) return authorized
  const account = req.account
  if (account?.name) return account.name
  if (account?.email) return account.email
  return req.actor.name
}

// Whether the object is being created through the Caracal Operator, as marked by the internal
// Control invoke hop.
export function isOperatorOrigin(req: FastifyRequest): boolean {
  return headerStr(req.headers[CREATED_VIA_HEADER]) === OPERATOR_ORIGIN
}

// Whether a zone shows the Caracal Operator co-authorship badge on objects created through the
// Operator. Default on, so a zone provisioned before the setting existed still stamps; a missing
// zone row also defaults on rather than silently dropping the stamp.
export async function zoneCoauthorEnabled(db: Queryable, zoneId: string): Promise<boolean> {
  const { rows } = await db.query<{ operator_coauthor_badge: boolean }>(
    `SELECT operator_coauthor_badge FROM zones WHERE id = $1 LIMIT 1`,
    [zoneId],
  )
  return rows[0]?.operator_coauthor_badge ?? true
}
