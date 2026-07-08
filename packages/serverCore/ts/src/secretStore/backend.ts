// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The SecretBackend abstraction: every durable credential write and read in Caracal goes through this interface.

export const SECRET_BACKEND_KINDS = [
  'builtin',
  'vault',
  'infisical',
  'azurekeyvault',
  'awssecretsmanager',
  'gcpsecretmanager',
  'custom',
] as const

export type SecretBackendKind = (typeof SECRET_BACKEND_KINDS)[number]

// A backend stores opaque secret values addressed by hierarchical refs. The control
// plane holds the full surface; the data plane only ever reads, so external backend
// credentials issued to the STS can be scoped read-only.
export interface SecretBackend {
  readonly kind: SecretBackendKind
  put(ref: string, value: Buffer): Promise<void>
  get(ref: string): Promise<Buffer | null>
  delete(ref: string): Promise<void>
}

// Raised when the configured backend cannot serve a request; callers map this to a
// service-unavailable response instead of leaking backend specifics.
export class SecretBackendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretBackendError'
  }
}

export function secretBackendKind(): SecretBackendKind {
  const raw = (process.env.CARACAL_SECRET_BACKEND || 'builtin').trim().toLowerCase()
  if ((SECRET_BACKEND_KINDS as readonly string[]).includes(raw)) return raw as SecretBackendKind
  throw new Error(`CARACAL_SECRET_BACKEND must be one of ${SECRET_BACKEND_KINDS.join(', ')}, got '${raw}'`)
}

export function providerSecretConfigRef(zoneId: string, providerId: string): string {
  return `zones/${zoneId}/providers/${providerId}/secretConfig`
}

// AAD strings for machine-generated runtime material sealed with the builtin envelope
// in its owning table. Fixed per column family so control-plane writes and data-plane
// reads agree; the connection token strings must match the Go constants.
export const AAD_CONNECTION_ACCESS_TOKEN = 'caracal/providerConnections/accessToken'
export const AAD_CONNECTION_REFRESH_TOKEN = 'caracal/providerConnections/refreshToken'
export const AAD_NOTIFICATION_SINK_SECRET = 'caracal/notificationSinks/secret'
export const AAD_OPERATOR_PLAN_SECRETS = 'caracal/operatorPlanSecrets/values'
