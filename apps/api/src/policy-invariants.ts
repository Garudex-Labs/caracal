// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Cross-route invariants binding application credential type to active policy references.

type QueryParam = string | number | boolean | null | string[]

export interface InvariantDB {
  query: <T = unknown>(text: string, params?: QueryParam[]) => Promise<{ rows: T[] }>
}

// publicAppsReferencedByContents returns the ids of zone applications whose
// credential_type is 'public' and whose id appears verbatim in any of the
// supplied policy contents. A public app named in a policy means an attacker
// who can reach Gateway with that client_id steals every right the policy
// grants to it; activation must refuse.
export async function publicAppsReferencedByContents(
  db: InvariantDB,
  zoneId: string,
  contents: string[],
): Promise<string[]> {
  if (contents.length === 0) return []
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM applications
     WHERE zone_id = $1 AND credential_type = 'public' AND archived_at IS NULL`,
    [zoneId],
  )
  if (rows.length === 0) return []
  const hits = new Set<string>()
  for (const app of rows) {
    for (const content of contents) {
      if (content.includes(app.id)) {
        hits.add(app.id)
        break
      }
    }
  }
  return [...hits]
}

// activePolicyReferencesApp reports whether any policy version bound as the
// active or shadow manifest in this zone contains the given application id.
// Used to refuse marking an app public when a live policy already grants it
// privilege under a confidential identity.
export async function activePolicyReferencesApp(
  db: InvariantDB,
  zoneId: string,
  appId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ matched: boolean }>(
    `WITH bindings AS (
       SELECT active_version_id AS vid FROM policy_set_bindings
       WHERE zone_id = $1 AND active_version_id IS NOT NULL
       UNION
       SELECT shadow_version_id AS vid FROM policy_set_bindings
       WHERE zone_id = $1 AND shadow_version_id IS NOT NULL
     ),
     refs AS (
       SELECT jsonb_array_elements(psv.manifest_json) ->> 'policy_version_id' AS pvid
       FROM policy_set_versions psv
       JOIN bindings b ON b.vid = psv.id
     )
     SELECT EXISTS (
       SELECT 1 FROM policy_versions pv
       WHERE pv.id IN (SELECT pvid FROM refs WHERE pvid IS NOT NULL)
         AND position($2 IN pv.content) > 0
     ) AS matched`,
    [zoneId, appId],
  )
  return rows[0]?.matched === true
}
