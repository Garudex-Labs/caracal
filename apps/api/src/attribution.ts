// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resolves the responsible human and Caracal Operator involvement for a mutation from the request's verified attribution signals.

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

// Attribution labels are stored on created objects and rendered by the console, so the header
// value must look like a human name or email: unicode letters, digits, and common name/email
// punctuation, capped at the control invoke's 256-character bound. Anything else is treated as
// tampering and attribution falls back to the verified identity on the request.
const CREATED_BY_PATTERN = /^[\p{L}\p{N} @._+'-]{1,256}$/u

// The name recorded as the actor of a mutation. The operator hop's authorized-by wins so an
// operator-driven change names the human the operator acted for; then the console operator's own
// name or email from the verified assertion; then the admin credential's own name for a direct
// admin or automation call.
export function resolveCreatedBy(req: FastifyRequest): string {
  const authorized = headerStr(req.headers[AUTHORIZED_BY_HEADER])
  if (authorized && CREATED_BY_PATTERN.test(authorized)) return authorized
  const account = req.account
  if (account?.name) return account.name
  if (account?.email) return account.email
  return req.actor.name
}

// Whether the mutation is being performed through the Caracal Operator, as marked by the internal
// Control invoke hop.
export function isOperatorOrigin(req: FastifyRequest): boolean {
  return headerStr(req.headers[CREATED_VIA_HEADER]) === OPERATOR_ORIGIN
}

// Whether a zone stamps and shows Caracal Operator involvement on objects the Operator creates or
// updates. Default on, so a zone provisioned before the setting existed still stamps; a missing
// zone row also defaults on rather than silently dropping the stamp.
export async function zoneCoauthorEnabled(db: Queryable, zoneId: string): Promise<boolean> {
  const { rows } = await db.query<{ operator_coauthor_badge: boolean }>(`SELECT operator_coauthor_badge FROM zones WHERE id = $1 LIMIT 1`, [
    zoneId,
  ])
  return rows[0]?.operator_coauthor_badge ?? true
}

// The attribution stamp every mutating route records: the responsible human and whether the
// change went through the Caracal Operator.
export interface Attribution {
  actor: string
  viaOperator: boolean
}

// Resolves the stamp for one mutation. The Operator flag honors the zone's attribution setting;
// a null zoneId (global objects, or a zone being created) skips the lookup and stamps whenever
// the request came through the Operator hop.
export async function resolveAttribution(req: FastifyRequest, db: Queryable, zoneId: string | null): Promise<Attribution> {
  return {
    actor: resolveCreatedBy(req),
    viaOperator: isOperatorOrigin(req) && (zoneId === null || (await zoneCoauthorEnabled(db, zoneId))),
  }
}
