// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime onboarding verifies the local stack reaches dependency-ready state.

import { defaultServiceProbes, stackStatus, type ProbeResult } from '@caracalai/engine'
import { printInfo, printStep, printSuccess } from '../style.ts'

const POLL_MS = 1000
const TIMEOUT_MS = 120_000
const HEARTBEAT_MS = 10_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pending(results: readonly ProbeResult[]): string[] {
  return results.filter((result) => !result.ok).map((result) => result.name)
}

function summarize(results: readonly ProbeResult[]): string {
  const failed = results.filter((result) => !result.ok)
  if (failed.length === 0) return 'no readiness probes returned ok'
  return failed.map((result) => `${result.name} ${result.detail}`).join('; ')
}

export async function completeRuntimeOnboarding(): Promise<void> {
  const probes = defaultServiceProbes('ready')
  const deadline = Date.now() + TIMEOUT_MS
  printInfo('waiting for runtime services to report ready (stack is running in the background)')
  let results: readonly ProbeResult[] = []
  let lastPending = ''
  let lastHeartbeat = Date.now()
  while (Date.now() < deadline) {
    results = await stackStatus({ probes })
    if (results.length > 0 && results.every((result) => result.ok)) {
      printSuccess('runtime services ready')
      return
    }
    const waiting = pending(results)
    const key = waiting.join(',')
    const now = Date.now()
    if (key !== lastPending || now - lastHeartbeat >= HEARTBEAT_MS) {
      printStep(`waiting on ${waiting.join(', ')}`)
      lastPending = key
      lastHeartbeat = now
    }
    await delay(POLL_MS)
  }
  throw new Error(`runtime onboarding did not become ready: ${summarize(results)}`)
}
