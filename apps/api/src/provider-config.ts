// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The provider configuration contract: the provider kinds and the public/secret config key sets every provider surface shares.

export const PROVIDER_KINDS = [
  'none',
  'caracal_mandate',
  'oauth2_authorization_code',
  'oauth2_client_credentials',
  'api_key',
  'bearer_token',
] as const

export type ProviderKind = (typeof PROVIDER_KINDS)[number]

// The non-secret config keys each provider kind accepts. These are safe to carry in a plan,
// a request body, or a stored provider row; anything outside this set and the secret set is
// rejected as unsupported.
export const PUBLIC_PROVIDER_CONFIG_KEYS: Record<ProviderKind, ReadonlySet<string>> = {
  none: new Set(),
  caracal_mandate: new Set(),
  oauth2_authorization_code: new Set([
    'authorization_endpoint',
    'token_endpoint',
    'redirect_uri',
    'client_id',
    'client_auth_method',
    'scopes',
    'allowed_token_hosts',
    'authorization_params',
    'token_params',
    'auth_header',
    'auth_scheme',
    'forward_caracal_identity',
    'allow_runtime_injection',
  ]),
  oauth2_client_credentials: new Set([
    'token_endpoint',
    'client_id',
    'client_auth_method',
    'scopes',
    'audience',
    'resource',
    'allowed_token_hosts',
    'token_params',
    'key_id',
    'auth_header',
    'auth_scheme',
    'forward_caracal_identity',
    'allow_runtime_injection',
  ]),
  api_key: new Set([
    'auth_location',
    'header_name',
    'query_param_name',
    'auth_scheme',
    'forward_caracal_identity',
    'allow_runtime_injection',
  ]),
  bearer_token: new Set(['allowed_token_hosts', 'auth_header', 'auth_scheme', 'forward_caracal_identity', 'allow_runtime_injection']),
}

// The secret config keys each provider kind seals at rest. A value under one of these keys
// must never appear in a conversation ledger, a plan argument, a model prompt, or a log.
export const SECRET_PROVIDER_CONFIG_KEYS: Record<ProviderKind, ReadonlySet<string>> = {
  none: new Set(),
  caracal_mandate: new Set(),
  oauth2_authorization_code: new Set(['client_secret']),
  oauth2_client_credentials: new Set(['client_secret', 'private_key']),
  api_key: new Set(['api_key']),
  bearer_token: new Set(['bearer_token']),
}
