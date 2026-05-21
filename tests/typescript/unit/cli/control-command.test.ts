// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the secured Control CLI command entry.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { controlCommand } from '../../../../apps/cli/src/commands/control.ts'

const originalEnv = { ...process.env }

afterEach(() => {
  vi.restoreAllMocks()
  process.env = { ...originalEnv }
})

describe('controlCommand', () => {
  it('rejects Control management through the thin shell CLI dispatch path', async () => {
    process.env = { ...originalEnv, CARACAL_INVOKED_AS: 'caracal cli' }
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`)
    }) as never)

    await expect(controlCommand(['status'])).rejects.toThrow('exit:1')
    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr.mock.calls.map((call) => call[0]).join('')).toContain('caracal-cli or the TUI Control menu')
  })
})
