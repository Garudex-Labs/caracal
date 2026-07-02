// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone overview route: one aggregated, zone-scoped read powering the Console dashboard.

import type { FastifyPluginAsync } from 'fastify'
import { ZoneParams, parseParams } from './params.js'
import { redactSensitive } from '../redact.js'

// The dashboard treats a credential as expiring when it lapses within this window.
const EXPIRING_WINDOW = '7 days'
// Authority decisions are summarized over a fixed recent window so the count means
// "denied in the last day", never "denied across the whole retained history".
const DECISION_WINDOW = '24 hours'
const RECENT_EVENTS_LIMIT = 10

export const zoneOverviewRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/overview', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const zone = [params.zoneId]

    const [apps, resources, providers, policySets, sessions, decisions, recent] =
      await Promise.all([
        fastify.db.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < now())::int AS expired,
                  count(*) FILTER (WHERE expires_at >= now() AND expires_at < now() + interval '${EXPIRING_WINDOW}')::int AS expiring_soon
           FROM applications
           WHERE zone_id = $1 AND archived_at IS NULL`,
          zone,
        ),
        fastify.db.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE operation_enforcement <> 'enforced')::int AS unenforced
           FROM resources
           WHERE zone_id = $1 AND archived_at IS NULL`,
          zone,
        ),
        fastify.db.query(
          `SELECT count(*)::int AS total
           FROM providers
           WHERE zone_id = $1 AND archived_at IS NULL`,
          zone,
        ),
        fastify.db.query(
          `SELECT count(*)::int AS total,
                  count(psb.active_version_id)::int AS enforcing,
                  min(ps.name) FILTER (WHERE psb.active_version_id IS NOT NULL) AS active_name
           FROM policy_sets ps
           LEFT JOIN policy_set_bindings psb ON psb.policy_set_id = ps.id AND psb.zone_id = ps.zone_id
           WHERE ps.zone_id = $1 AND ps.archived_at IS NULL`,
          zone,
        ),
        fastify.db.query(
          `SELECT count(*)::int AS active
           FROM sessions
           WHERE zone_id = $1 AND status = 'active' AND expires_at > now()`,
          zone,
        ),
        fastify.db.query(
          `SELECT count(*) FILTER (WHERE decision = 'allow')::int AS allowed,
                  count(*) FILTER (WHERE decision = 'deny')::int AS denied
           FROM audit_events
           WHERE zone_id = $1 AND occurred_at >= now() - interval '${DECISION_WINDOW}'`,
          zone,
        ),
        fastify.db.query(
          `SELECT id, event_type, request_id, decision, metadata_json, occurred_at
           FROM audit_events
           WHERE zone_id = $1
           ORDER BY occurred_at DESC, id DESC
           LIMIT ${RECENT_EVENTS_LIMIT}`,
          zone,
        ),
      ])

    return {
      zone_id: params.zoneId,
      generated_at: new Date().toISOString(),
      applications: apps.rows[0],
      resources: resources.rows[0],
      providers: providers.rows[0],
      policy_sets: policySets.rows[0],
      sessions: sessions.rows[0],
      decisions_24h: decisions.rows[0],
      recent_events: recent.rows.map((r) => ({
        ...r,
        metadata_json: redactSensitive(r.metadata_json),
      })),
    }
  })
}
