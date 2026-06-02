// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime onboarding readiness polling tests.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const engineMocks = vi.hoisted(() => ({
  defaultServiceProbes: vi.fn(() => [{ name: 'api' }]),
  stackStatus: vi.fn(),
}))

vi.mock('@caracalai/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@caracalai/engine')>()
  return { ...actual, ...engineMocks }
})

const { completeRuntimeOnboarding } = await import('../../../../apps/runtime/src/commands/onboarding.ts')

describe('completeRuntimeOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prints success when readiness probes pass', async () => {
    let stdout = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    })
    engineMocks.stackStatus.mockResolvedValueOnce([{ name: 'api', ok: true, detail: '200' }])
    try {
      await completeRuntimeOnboarding()
      expect(engineMocks.defaultServiceProbes).toHaveBeenCalledWith(undefined, 'ready')
      expect(engineMocks.stackStatus).toHaveBeenCalledWith({ probes: [{ name: 'api' }] })
      expect(stdout).toContain('runtime services ready')
    } finally {
      write.mockRestore()
    }
  })

  it('times out with the last failed probe summary', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-06-02T10:00:00Z'))
      engineMocks.stackStatus.mockResolvedValue([{ name: 'api', ok: false, detail: '503' }])
      const task = completeRuntimeOnboarding()
      const assertion = expect(task).rejects.toThrow('api 503')
      await vi.advanceTimersByTimeAsync(120_000)

      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out clearly when probes never return a ready result', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-06-02T10:00:00Z'))
      engineMocks.stackStatus.mockResolvedValue([])
      const task = completeRuntimeOnboarding()
      const assertion = expect(task).rejects.toThrow('no readiness probes returned ok')
      await vi.advanceTimersByTimeAsync(120_000)

      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
