// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Protect the awaited pool initialization contract, including its fail-closed error path.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const construct = vi.hoisted(() => vi.fn())
vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(options: unknown) {
        construct(options)
      }
      on() {
        return this
      }
    },
  },
}))
import { newDB } from '../../../../apps/api/src/db.js'

beforeEach(() => {
  construct.mockClear()
})

describe('newDB initialization', () => {
  it('awaits the zone GUC before making a session usable', async () => {
    newDB({ connectionString: 'postgres://unused' })
    const options = construct.mock.calls[0][0]
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const client = { query: vi.fn(() => pending), on: vi.fn() }
    let done = false
    const initialized = options.onConnect(client).then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    expect(client.query).toHaveBeenCalledWith("SELECT set_config('caracal.zone_id', '*', false)")
    finish()
    await initialized
    expect(done).toBe(true)
    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('rejects a failed initializer so pg-pool discards the session', async () => {
    const report = vi.fn()
    newDB({ connectionString: 'postgres://unused', onZoneGUCError: report })
    const error = new Error('initialization failed')
    const client = { query: vi.fn().mockRejectedValue(error), on: vi.fn() }
    await expect(construct.mock.calls[0][0].onConnect(client)).rejects.toBe(error)
    expect(report).toHaveBeenCalledWith(error)
  })
})
