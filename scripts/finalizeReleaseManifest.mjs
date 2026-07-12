#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Finalizes release metadata with the immutable source commit used by CI.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commitPattern, writeJsonAtomic } from './lib/releaseSpec.mjs'

export function finalizeManifest(manifest, sourceSha, generatedAt = manifest.generatedAt) {
  if (!commitPattern.test(sourceSha)) throw new Error(`source SHA must be a full lowercase Git commit, got ${sourceSha}`)
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) throw new Error(`generatedAt must be an ISO timestamp, got ${generatedAt}`)
  return {
    ...structuredClone(manifest),
    sha: sourceSha,
    generatedAt: new Date(generatedAt).toISOString(),
    source: {
      gitSha: sourceSha,
      dirty: false,
    },
  }
}

function main() {
  const [input, output, sourceSha, generatedAt] = process.argv.slice(2)
  if (!input || !output || !sourceSha || !generatedAt) {
    throw new Error('usage: finalizeReleaseManifest.mjs <input> <output> <source-sha> <source-timestamp>')
  }
  if (resolve(input) === resolve(output)) throw new Error('input and output manifest paths must differ')
  const manifest = JSON.parse(readFileSync(resolve(input), 'utf8'))
  const finalized = finalizeManifest(manifest, sourceSha, generatedAt)
  writeJsonAtomic(resolve(output), finalized)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
