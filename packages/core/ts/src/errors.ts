// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared error codes and types for TypeScript services.

import type { JsonObject } from './json.js';

export type WellKnownErrorCode =
  | 'access_denied'
  | 'invalid_token'
  | 'resource_not_found'
  | 'internal_error'
  | 'policy_eval_failed'
  | 'provider_rate_limited'
  | 'interaction_required'
  | 'sts_unavailable'
  | 'credential_expired_not_renewable'
  | 'payload_too_large'
  | 'zone_invalid'
  | 'scope_insufficient'
  | 'agent_identity_required'
  | 'delegation_required'
  | 'chain_mismatch'
  | 'hop_count_exceeded'
  | 'http_request_failed'
  | 'config_missing';

// Permits server-supplied or upstream-defined codes alongside well-known ones,
// while still autocompleting WellKnownErrorCode literals.
export type ErrorCode = WellKnownErrorCode | (string & {});

export interface CaracalErrorOptions {
  requestId?: string;
  details?: JsonObject;
  cause?: unknown;
}

export class CaracalError extends Error {
  readonly code: ErrorCode;
  readonly requestId?: string;
  readonly details?: JsonObject;

  constructor(code: ErrorCode, message: string, opts: CaracalErrorOptions | string = {}) {
    const options: CaracalErrorOptions = typeof opts === 'string' ? { requestId: opts } : opts;
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CaracalError';
    this.code = code;
    if (options.requestId) this.requestId = options.requestId;
    if (options.details) this.details = options.details;
  }

  toJSON() {
    return {
      error: this.code,
      error_description: this.message,
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}
