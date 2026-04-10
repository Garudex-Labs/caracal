/**
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Shared SDK error types.
 */

export class SDKConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SDKConfigurationError';
  }
}
