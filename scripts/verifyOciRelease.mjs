#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies published OCI images against the exact release source commit.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [sourceSha, releaseTag] = process.argv.slice(2)
if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '') || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?$/.test(releaseTag ?? '')) {
  throw new Error('usage: verifyOciRelease.mjs <source-sha> <release-tag>')
}

const config = JSON.parse(readFileSync(resolve('release.config.json'), 'utf8'))
const registry = (process.env.CARACAL_OCI_REGISTRY ?? 'ghcr.io/garudex-labs').replace(/\/$/, '')

for (const image of config.product.containers) {
  const reference = `${registry}/caracal-${image.name}:${releaseTag}`
  const output = execFileSync('gh', ['attestation', 'verify', `oci://${reference}`, '--repo', 'Garudex-Labs/caracal', '--format', 'json'], {
    encoding: 'utf8',
  })
  const results = JSON.parse(output)
  const verified = results.some((result) => {
    const certificate = result.verificationResult?.signature?.certificate
    return (
      certificate?.sourceRepositoryURI === 'https://github.com/Garudex-Labs/caracal' &&
      certificate?.sourceRepositoryDigest === sourceSha &&
      certificate?.sourceRepositoryRef === `refs/tags/${releaseTag}`
    )
  })
  if (!verified) throw new Error(`${reference} has no provenance for ${releaseTag} at ${sourceSha}`)
  process.stdout.write(`${reference} has verified source provenance\n`)
}
