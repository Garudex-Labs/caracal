// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TypeScript shared error tests for canonical JSON response shape.

import { describe, expect, it } from 'vitest'
import { CaracalError } from '../../../../packages/core/ts/src/errors.js'

describe('CaracalError', () => {
  it('serializes code, description, and request id', () => {
    const err = new CaracalError('invalid_token', 'bad token', 'req-1')

    expect(err.name).toBe('CaracalError')
    expect(err.message).toBe('bad token')
    expect(err.toJSON()).toEqual({
      error: 'invalid_token',
      error_description: 'bad token',
      requestId: 'req-1',
    })
  })

  it('omits request id when absent', () => {
    expect(new CaracalError('access_denied', 'denied').toJSON()).toEqual({
      error: 'access_denied',
      error_description: 'denied',
    })
  })
})
