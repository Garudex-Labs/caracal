// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Error type raised for non-2xx admin API responses.

import { CaracalError, redact, type JsonValue } from '@caracalai/core'

export type AdminApiErrorCode =
  | 'application_not_found'
  | 'authorization_code_required'
  | 'challenge_not_found'
  | 'challenge_not_satisfiable'
  | 'dcr_shutdown_required'
  | 'gateway_application_must_be_managed'
  | 'gateway_application_not_found'
  | 'gateway_application_required'
  | 'grant_not_found'
  | 'grant_scopes_exceed_resource'
  | 'invalid_cursor'
  | 'invalid_provider'
  | 'invalid_provider_config'
  | 'invalid_provider_grant'
  | 'invalid_provider_identifier'
  | 'invalid_provider_oauth_authorize'
  | 'invalid_provider_grant_revoke'
  | 'invalid_query'
  | 'invalid_request'
  | 'invalid_token'
  | 'oauth_state_expired'
  | 'oauth_state_invalid'
  | 'oauth_state_mismatch'
  | 'policy_template_not_found'
  | 'provider_authorization_endpoint_invalid'
  | 'provider_grant_not_found'
  | 'provider_grant_unsupported'
  | 'provider_identifier_conflict'
  | 'provider_not_found'
  | 'provider_oauth_denied'
  | 'provider_resource_mismatch'
  | 'provider_token_endpoint_not_allowed'
  | 'provider_token_exchange_failed'
  | 'provider_token_response_invalid'
  | 'resource_not_found'
  | 'zone_not_found'

export class AdminApiError extends CaracalError {
  readonly status: number
  readonly body: JsonValue
  readonly target: 'api' | 'coordinator'

  constructor(status: number, code: AdminApiErrorCode | (string & {}), body: JsonValue, message?: string, target: 'api' | 'coordinator' = 'api') {
    const safeBody = redact(body) as JsonValue
    super(code, message ?? `${code} (HTTP ${status})`, { details: { status, body: safeBody, target } })
    this.name = 'AdminApiError'
    this.status = status
    this.body = safeBody
    this.target = target
  }
}
