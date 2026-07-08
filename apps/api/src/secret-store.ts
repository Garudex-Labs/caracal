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
  SealedBackend,
  VaultBackend,
  secretBackendKind,
  type SecretBackend,
  type SecretBackendKind,
} from '@caracalai/server-core'
import type { DB } from './db.js'

// The builtin Secret Store: rows in the secret_store table keyed by ref. Values
// arrive already sealed by the crypto boundary, so this layer only moves bytes.
export class BuiltinSecretBackend implements SecretBackend {
  readonly kind = 'builtin'

  constructor(private readonly db: DB) {}

  async put(ref: string, value: Buffer): Promise<void> {
    await this.db.query(
      `INSERT INTO secret_store (ref, zone_id, envelope)
       VALUES ($1, $2, $3)
       ON CONFLICT (ref) DO UPDATE SET envelope = EXCLUDED.envelope, version = secret_store.version + 1, updated_at = now()`,
      [ref, zoneFromRef(ref), value],
    )
  }

  async get(ref: string): Promise<Buffer | null> {
    const { rows } = await this.db.query<{ envelope: Buffer }>(`SELECT envelope FROM secret_store WHERE ref = $1`, [ref])
    if (rows.length === 0) return null
    return rows[0].envelope
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

// The storage layer beneath the crypto boundary. Exposed separately so backend
// migration can move sealed envelopes between stores without opening them.
export function buildRawSecretBackend(db: DB, kind: SecretBackendKind): SecretBackend {
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

export function buildSecretBackend(db: DB): SecretBackend {
  return new SealedBackend(buildRawSecretBackend(db, secretBackendKind()))
}

export const secretBackendCounters = { operations: 0, errors: 0 }

// Counts every secret backend operation and failure for the /metrics surface,
// so operators can see backend outages and unusual credential access volumes.
export class MeteredBackend implements SecretBackend {
  constructor(private readonly inner: SecretBackend) {}

  get kind(): SecretBackendKind {
    return this.inner.kind
  }

  private async count<T>(operation: Promise<T>): Promise<T> {
    secretBackendCounters.operations++
    try {
      return await operation
    } catch (err) {
      secretBackendCounters.errors++
      throw err
    }
  }

  put(ref: string, value: Buffer): Promise<void> {
    return this.count(this.inner.put(ref, value))
  }

  get(ref: string): Promise<Buffer | null> {
    return this.count(this.inner.get(ref))
  }

  delete(ref: string): Promise<void> {
    return this.count(this.inner.delete(ref))
  }
}
