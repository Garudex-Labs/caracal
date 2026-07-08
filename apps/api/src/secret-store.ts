// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Secret backend wiring for the control plane: the builtin database-backed store and the external backend factory.

import {
  AzureKeyVaultBackend,
  AwsSecretsManagerBackend,
  CustomBackend,
  GcpSecretManagerBackend,
  InfisicalBackend,
  VaultBackend,
  loadSecretStoreKek,
  openEnvelope,
  sealEnvelope,
  secretBackendKind,
  type SecretBackend,
} from '@caracalai/server-core'
import type { DB } from './db.js'

// The builtin Secret Store: CSS1 envelopes in the secret_store table, sealed under
// the master KEK held only in process memory. The ref doubles as AAD so a row
// copied to another ref fails authentication.
export class BuiltinSecretBackend implements SecretBackend {
  readonly kind = 'builtin'

  constructor(private readonly db: DB) {}

  async put(ref: string, value: Buffer): Promise<void> {
    const envelope = sealEnvelope(loadSecretStoreKek(), value, ref)
    await this.db.query(
      `INSERT INTO secret_store (ref, zone_id, envelope)
       VALUES ($1, $2, $3)
       ON CONFLICT (ref) DO UPDATE SET envelope = EXCLUDED.envelope, version = secret_store.version + 1, updated_at = now()`,
      [ref, zoneFromRef(ref), envelope],
    )
  }

  async get(ref: string): Promise<Buffer | null> {
    const { rows } = await this.db.query<{ envelope: Buffer }>(`SELECT envelope FROM secret_store WHERE ref = $1`, [ref])
    if (rows.length === 0) return null
    return openEnvelope(loadSecretStoreKek(), rows[0].envelope, ref)
  }

  async delete(ref: string): Promise<void> {
    await this.db.query(`DELETE FROM secret_store WHERE ref = $1`, [ref])
  }
}

// Refs are hierarchical with the owning zone as the second segment
// (zones/{zoneId}/...), which feeds the zone_id column for row-level security.
function zoneFromRef(ref: string): string {
  const segments = ref.split('/')
  if (segments[0] !== 'zones' || !segments[1]) throw new Error(`secret ref has no zone segment: ${ref}`)
  return segments[1]
}

export function buildSecretBackend(db: DB): SecretBackend {
  const kind = secretBackendKind()
  switch (kind) {
    case 'builtin':
      return new BuiltinSecretBackend(db)
    case 'vault':
      return new VaultBackend()
    case 'infisical':
      return new InfisicalBackend()
    case 'azurekeyvault':
      return new AzureKeyVaultBackend()
    case 'awssecretsmanager':
      return new AwsSecretsManagerBackend()
    case 'gcpsecretmanager':
      return new GcpSecretManagerBackend()
    case 'custom':
      return new CustomBackend()
  }
}
