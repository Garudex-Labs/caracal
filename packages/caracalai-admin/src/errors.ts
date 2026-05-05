// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Error type raised for non-2xx admin API responses.

export class AdminApiError extends Error {
  readonly status: number
  readonly code: string
  readonly body: unknown

  constructor(status: number, code: string, body: unknown, message?: string) {
    super(message ?? `${code} (HTTP ${status})`)
    this.name = 'AdminApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}
