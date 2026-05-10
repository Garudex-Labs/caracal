// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared error codes and types for TypeScript services.

export type ErrorCode =
  | 'access_denied'
  | 'invalid_token'
  | 'resource_not_found'
  | 'internal_error'
  | 'policy_eval_failed'
  | 'provider_rate_limited'
  | 'interaction_required'
  | 'sts_unavailable'
  | 'credential_expired_not_renewable'
  | 'payload_too_large';

export class CaracalError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'CaracalError';
  }

  toJSON() {
    return {
      error: this.code,
      error_description: this.message,
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}
