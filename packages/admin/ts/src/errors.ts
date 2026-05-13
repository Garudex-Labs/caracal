// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Error type raised for non-2xx admin API responses.

import { CaracalError } from '@caracalai/core'

export class AdminApiError extends CaracalError {
  readonly status: number
  readonly body: unknown

  constructor(status: number, code: string, body: unknown, message?: string) {
    super(code, message ?? `${code} (HTTP ${status})`, { details: { status, body } })
    this.name = 'AdminApiError'
    this.status = status
    this.body = body
  }
}
