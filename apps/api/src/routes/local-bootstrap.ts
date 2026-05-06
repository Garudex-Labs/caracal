// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Local bootstrap: provisions zone1/app1/resource://example for the OSS CLI in one transaction.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { createCipheriv, createHash, generateKeyPairSync, randomBytes } from 'node:crypto'

const ZONE_ID = 'zone1'
const APP_ID = 'app1'
const RESOURCE_ID = 'resource1'
const RESOURCE_NAME = 'resource://example'
const POLICY_ID = 'local-dev-allow'
const POLICY_VERSION_ID = 'local-dev-allow-v1'
const POLICY_SET_ID = 'local-dev-policy-set'
const POLICY_SET_VERSION_ID = 'local-dev-policy-set-v1'
const SIGNING_KEY_ID = 'zone1-signing-key-v1'
const ALLOW_POLICY = `package caracal.authz
result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "local-dev-allow"}], "diagnostics": []}
`

const BootstrapBody = z.object({
  force: z.boolean().optional().default(false),
})

interface BootstrapResult {
  zone_id: string
  app_id: string
  app_client_id: string
  app_client_secret: string | null
  resource: string
  scope: string
  rotated: boolean
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function sealZeroKey(plaintext: Buffer): { ciphertext: Buffer; nonce: Buffer } {
  const key = Buffer.alloc(32)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return { ciphertext: Buffer.concat([enc, tag]), nonce }
}

function generateSigningKeyPem(): Buffer {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pem = privateKey.export({ format: 'pem', type: 'sec1' })
  return Buffer.from(pem as string, 'utf8')
}

export const localBootstrapRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/local/bootstrap', async (req, reply) => {
    const parsed = BootstrapBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' })
    const { force } = parsed.data

    const existing = await fastify.db.query(`SELECT id FROM zones WHERE id = $1`, [ZONE_ID])
    const zoneExists = existing.rowCount! > 0

    if (zoneExists) {
      const { rows: secretRows } = await fastify.db.query<{ dek_id: string }>(
        `SELECT dek_id FROM secrets WHERE id = $1 AND zone_id = $2`,
        [SIGNING_KEY_ID, ZONE_ID],
      )
      if (secretRows[0] && secretRows[0].dek_id !== 'local') {
        return reply.code(409).send({
          error: 'zone_not_local_bootstrap',
          detail: 'refusing to overwrite zone whose signing key was sealed under a real KEK',
        })
      }
    }

    if (zoneExists && !force) {
      return {
        zone_id: ZONE_ID,
        app_id: APP_ID,
        app_client_id: `${ZONE_ID}:${APP_ID}`,
        app_client_secret: null,
        resource: RESOURCE_NAME,
        scope: 'read',
        rotated: false,
      } satisfies BootstrapResult
    }

    const clientSecret = randomBytes(24).toString('hex')
    const clientSecretHash = sha256Hex(clientSecret)
    const policyHash = sha256Hex(ALLOW_POLICY)
    const manifest = JSON.stringify([{ policy_version_id: POLICY_VERSION_ID }])
    const manifestHash = sha256Hex(manifest)
    const signingPem = generateSigningKeyPem()
    const sealed = sealZeroKey(signingPem)

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')

      await client.query(
        `INSERT INTO zones (id, org_id, name, slug, dek_ciphertext, dcr_enabled, pkce_required, login_flow)
         VALUES ($1, 'local', 'Local Dev', 'local-dev', gen_random_bytes(32), true, false, 'default')
         ON CONFLICT (id) DO NOTHING`,
        [ZONE_ID],
      )
      await client.query(
        `INSERT INTO applications (id, zone_id, name, registration_method, credential_type, client_secret_hash, traits, consent)
         VALUES ($1, $2, 'Local CLI', 'managed', 'password', $3, '{}', 'implicit')
         ON CONFLICT (id) DO UPDATE SET client_secret_hash = EXCLUDED.client_secret_hash, updated_at = now()`,
        [APP_ID, ZONE_ID, clientSecretHash],
      )
      await client.query(
        `INSERT INTO resources (id, zone_id, name, identifier, prefix, scopes)
         VALUES ($1, $2, 'Example Resource', $3, false, ARRAY['read'])
         ON CONFLICT (zone_id, identifier) DO NOTHING`,
        [RESOURCE_ID, ZONE_ID, RESOURCE_NAME],
      )
      await client.query(
        `INSERT INTO policies (id, zone_id, name, description, owner_type, created_by)
         VALUES ($1, $2, 'Local Dev Allow', 'Allows the local CLI example resource.', 'customer', 'local-bootstrap')
         ON CONFLICT (id) DO NOTHING`,
        [POLICY_ID, ZONE_ID],
      )
      await client.query(
        `INSERT INTO policy_versions (id, policy_id, version, content, content_sha256, schema_version, created_by)
         VALUES ($1, $2, 1, $3, $4, '2026-03-16', 'local-bootstrap')
         ON CONFLICT (id) DO NOTHING`,
        [POLICY_VERSION_ID, POLICY_ID, ALLOW_POLICY, policyHash],
      )
      await client.query(
        `INSERT INTO policy_sets (id, zone_id, name, description, created_by)
         VALUES ($1, $2, 'Local Dev Policy Set', 'Policy set for local CLI testing.', 'local-bootstrap')
         ON CONFLICT (id) DO NOTHING`,
        [POLICY_SET_ID, ZONE_ID],
      )
      await client.query(
        `INSERT INTO policy_set_versions (id, policy_set_id, version, manifest_json, manifest_sha256, schema_version, created_by)
         VALUES ($1, $2, 1, $3::jsonb, $4, '2026-03-16', 'local-bootstrap')
         ON CONFLICT (id) DO NOTHING`,
        [POLICY_SET_VERSION_ID, POLICY_SET_ID, manifest, manifestHash],
      )
      await client.query(
        `INSERT INTO policy_set_bindings (zone_id, policy_set_id, active_version_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (zone_id, policy_set_id) DO UPDATE SET active_version_id = EXCLUDED.active_version_id, updated_at = now()`,
        [ZONE_ID, POLICY_SET_ID, POLICY_SET_VERSION_ID],
      )
      await client.query(
        `INSERT INTO secrets (id, zone_id, entity_id, name, type, ciphertext, nonce, dek_id)
         VALUES ($1, $2, $2, 'zone_signing_key', 'token', $3, $4, 'local')
         ON CONFLICT (id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, updated_at = now()`,
        [SIGNING_KEY_ID, ZONE_ID, sealed.ciphertext, sealed.nonce],
      )

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return reply.code(zoneExists ? 200 : 201).send({
      zone_id: ZONE_ID,
      app_id: APP_ID,
      app_client_id: `${ZONE_ID}:${APP_ID}`,
      app_client_secret: clientSecret,
      resource: RESOURCE_NAME,
      scope: 'read',
      rotated: zoneExists,
    } satisfies BootstrapResult)
  })
}
