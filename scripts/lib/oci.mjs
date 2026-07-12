// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared OCI image and chart inspection helpers with transient-failure retries.

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { imageDigestPattern } from './releaseSpec.mjs'

export const ociMissingPattern = /(?:manifest unknown|name unknown|not found)/i

const inspectAttempts = 3
const retryDelayMs = 5_000

async function ociState(command, args, reference) {
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    if (result.error) throw result.error
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    if (result.status === 0) return { exists: true, stdout: result.stdout ?? '' }
    if (ociMissingPattern.test(output)) return { exists: false, stdout: '' }
    if (attempt >= inspectAttempts) throw new Error(`could not inspect ${reference}: ${output.trim()}`)
    process.stderr.write(`transient failure inspecting ${reference}; retrying (${attempt})\n`)
    await delay(retryDelayMs)
  }
}

export async function imageDigest(reference, { required = true } = {}) {
  const state = await ociState('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'], reference)
  if (!state.exists) {
    if (required) throw new Error(`image not found: ${reference}`)
    return null
  }
  const digest = JSON.parse(state.stdout).digest
  if (!imageDigestPattern.test(digest ?? '')) throw new Error(`${reference} returned invalid digest ${digest}`)
  return digest
}

export async function imageExists(reference) {
  const state = await ociState('docker', ['buildx', 'imagetools', 'inspect', reference], reference)
  return state.exists
}

export async function chartExists(reference, version) {
  const state = await ociState('helm', ['show', 'chart', reference, '--version', version], `${reference}:${version}`)
  return state.exists
}
