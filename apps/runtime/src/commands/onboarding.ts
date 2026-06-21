// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime onboarding verifies the local stack reaches dependency-ready state.

import {
  defaultServiceProbes,
  stackStatus,
  type ProbeResult,
} from '@caracalai/engine'
import { printInfo } from '../style.ts'

const POLL_MS = 1000
const TIMEOUT_MS = 120_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function summarize(results: readonly ProbeResult[]): string {
  const failed = results.filter((result) => !result.ok)
  if (failed.length === 0) return 'no readiness probes returned ok'
  return failed.map((result) => `${result.name} ${result.detail}`).join('; ')
}

export async function completeRuntimeOnboarding(): Promise<void> {
  const probes = defaultServiceProbes('ready')
  const deadline = Date.now() + TIMEOUT_MS
  let results: readonly ProbeResult[] = []
  while (Date.now() < deadline) {
    results = await stackStatus({ probes })
    if (results.length > 0 && results.every((result) => result.ok)) {
      printInfo('runtime services ready')
      return
    }
    await delay(POLL_MS)
  }
  throw new Error(`runtime onboarding did not become ready: ${summarize(results)}`)
}
