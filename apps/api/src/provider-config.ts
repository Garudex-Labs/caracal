// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The provider configuration contract: the provider kinds, the per-kind field table, and the public/secret config key sets every provider surface shares.

export const PROVIDER_KINDS = [
  'none',
  'caracal_mandate',
  'oauth2_authorization_code',
  'oauth2_client_credentials',
  'api_key',
  'bearer_token',
  'http_basic',
] as const

export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export interface ProviderConfigField {
  key: string
  // Whether the console form and the control plane demand the field for this kind. A note
  // qualifies conditional requirements (for example "when auth_location is header").
  requirement: 'required' | 'optional'
  // Secret fields are sealed at rest and must never appear in a conversation ledger, a plan
  // argument, a model prompt, or a log; the console collects them through masked inputs and
  // the Operator collects them through the secure credential prompt.
  secret?: boolean
  note?: string
}

// The single source of truth for what each provider kind accepts. The console form, the control
// plane validation, and the Operator's field guidance all describe exactly this table, so a field
// can never be presented differently across surfaces.
export const PROVIDER_CONFIG_FIELDS: Record<ProviderKind, readonly ProviderConfigField[]> = {
  none: [],
  caracal_mandate: [],
  oauth2_authorization_code: [
    { key: 'authorization_endpoint', requirement: 'required', note: 'HTTPS endpoint where users approve delegated access' },
    { key: 'token_endpoint', requirement: 'required', note: 'HTTPS endpoint where tokens are issued or refreshed' },
    { key: 'redirect_uri', requirement: 'required', note: "Caracal's callback URL for the zone, registered with the provider" },
    { key: 'client_id', requirement: 'required', note: 'the OAuth client id' },
    { key: 'client_secret', requirement: 'required', secret: true, note: 'not used when client_auth_method is none' },
    { key: 'scopes', requirement: 'optional', note: 'upstream OAuth scopes to request' },
    { key: 'client_auth_method', requirement: 'optional', note: 'client_secret_basic default, client_secret_post, or none' },
    { key: 'allowed_token_hosts', requirement: 'optional', note: 'defaults to the token endpoint host' },
    { key: 'authorization_params', requirement: 'optional' },
    { key: 'token_params', requirement: 'optional' },
    { key: 'auth_header', requirement: 'optional' },
    { key: 'auth_scheme', requirement: 'optional' },
    { key: 'forward_caracal_identity', requirement: 'optional' },
    { key: 'allow_runtime_injection', requirement: 'optional' },
  ],
  oauth2_client_credentials: [
    { key: 'token_endpoint', requirement: 'required', note: 'HTTPS endpoint where tokens are issued' },
    { key: 'client_id', requirement: 'required', note: 'the OAuth client id' },
    { key: 'client_secret', requirement: 'required', secret: true, note: 'not used with private_key_jwt or none' },
    { key: 'private_key', requirement: 'optional', secret: true, note: 'PEM key, required with private_key_jwt or jwt_bearer' },
    { key: 'scopes', requirement: 'optional', note: 'upstream OAuth scopes to request' },
    {
      key: 'client_auth_method',
      requirement: 'optional',
      note: 'client_secret_basic default, client_secret_post, private_key_jwt, or none',
    },
    { key: 'grant_type', requirement: 'optional', note: 'client_credentials default, or jwt_bearer for RFC 7523 assertion grants' },
    { key: 'assertion_subject', requirement: 'optional', note: 'jwt_bearer only; sub claim, defaults to the client id' },
    { key: 'assertion_audience', requirement: 'optional', note: 'jwt_bearer only; aud claim, defaults to the token endpoint' },
    { key: 'audience', requirement: 'optional' },
    { key: 'resource', requirement: 'optional' },
    { key: 'allowed_token_hosts', requirement: 'optional', note: 'defaults to the token endpoint host' },
    { key: 'token_params', requirement: 'optional' },
    { key: 'key_id', requirement: 'optional', note: 'private_key_jwt or jwt_bearer only' },
    { key: 'certificate', requirement: 'optional', note: 'private_key_jwt only; PEM certificate for x5t thumbprint headers' },
    { key: 'auth_header', requirement: 'optional' },
    { key: 'auth_scheme', requirement: 'optional' },
    { key: 'forward_caracal_identity', requirement: 'optional' },
    { key: 'allow_runtime_injection', requirement: 'optional' },
  ],
  api_key: [
    { key: 'auth_location', requirement: 'optional', note: 'header default, or query' },
    { key: 'header_name', requirement: 'required', note: 'when auth_location is header' },
    { key: 'query_param_name', requirement: 'required', note: 'when auth_location is query' },
    { key: 'api_key', requirement: 'required', secret: true },
    { key: 'auth_scheme', requirement: 'optional', note: 'header auth only' },
    { key: 'forward_caracal_identity', requirement: 'optional' },
    { key: 'allow_runtime_injection', requirement: 'optional' },
  ],
  bearer_token: [
    { key: 'bearer_token', requirement: 'required', secret: true },
    { key: 'allowed_token_hosts', requirement: 'optional', note: 'host allow-list for forwarding' },
    { key: 'auth_header', requirement: 'optional' },
    { key: 'auth_scheme', requirement: 'optional' },
    { key: 'forward_caracal_identity', requirement: 'optional' },
    { key: 'allow_runtime_injection', requirement: 'optional' },
  ],
  // Basic credentials are a two-part secret, so the kind stays Gateway-forwarded only:
  // runtime injection delivers a single credential string per binding and cannot carry
  // the username/password pair without inventing a joining convention.
  http_basic: [
    { key: 'username', requirement: 'required', note: 'username or account identifier for HTTP Basic auth' },
    { key: 'password', requirement: 'required', secret: true, note: 'password or API token paired with the username' },
    { key: 'forward_caracal_identity', requirement: 'optional' },
  ],
}

function configKeys(secret: boolean): Record<ProviderKind, ReadonlySet<string>> {
  const keys = {} as Record<ProviderKind, ReadonlySet<string>>
  for (const kind of PROVIDER_KINDS) {
    keys[kind] = new Set(PROVIDER_CONFIG_FIELDS[kind].filter((field) => Boolean(field.secret) === secret).map((field) => field.key))
  }
  return keys
}

// The non-secret config keys each provider kind accepts. These are safe to carry in a plan,
// a request body, or a stored provider row; anything outside this set and the secret set is
// rejected as unsupported.
export const PUBLIC_PROVIDER_CONFIG_KEYS = configKeys(false)

// The secret config keys each provider kind seals at rest. A value under one of these keys
// must never appear in a conversation ledger, a plan argument, a model prompt, or a log.
export const SECRET_PROVIDER_CONFIG_KEYS = configKeys(true)
