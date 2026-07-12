#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Promotes verified source images to immutable release tags without rebuilding.

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [sourceSha, releaseTag] = process.argv.slice(2)
if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '') || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?$/.test(releaseTag ?? '')) {
  throw new Error('usage: publishOciRelease.mjs <source-sha> <release-tag>')
}

const config = JSON.parse(readFileSync(resolve('release.config.json'), 'utf8'))
const registry = (process.env.CARACAL_OCI_REGISTRY ?? 'ghcr.io/garudex-labs').replace(/\/$/, '')

function digest(reference, required = true) {
  const result = spawnSync('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'], {
    encoding: 'utf8',
  })
  if (result.status === 0) {
    const value = JSON.parse(result.stdout).digest
    if (!/^sha256:[0-9a-f]{64}$/.test(value ?? '')) throw new Error(`${reference} returned invalid digest ${value}`)
    return value
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (!required && /(?:manifest unknown|name unknown|not found)/i.test(output)) return null
  throw new Error(`could not inspect ${reference}: ${output.trim()}`)
}

function verify(reference) {
  const output = execFileSync('gh', ['attestation', 'verify', `oci://${reference}`, '--repo', 'Garudex-Labs/caracal', '--format', 'json'], {
    encoding: 'utf8',
  })
  const verified = JSON.parse(output).some((result) => {
    const certificate = result.verificationResult?.signature?.certificate
    return (
      certificate?.sourceRepositoryURI === 'https://github.com/Garudex-Labs/caracal' &&
      certificate?.sourceRepositoryDigest === sourceSha &&
      certificate?.sourceRepositoryRef === `refs/tags/${releaseTag}`
    )
  })
  if (!verified) throw new Error(`${reference} has no provenance for ${releaseTag} at ${sourceSha}`)
}

for (const image of config.product.containers) {
  const base = `${registry}/caracal-${image.name}`
  const source = `${base}:sha-${sourceSha}`
  const release = `${base}:${releaseTag}`
  const sourceDigest = digest(source)
  verify(source)
  const releaseDigest = digest(release, false)
  if (releaseDigest && releaseDigest !== sourceDigest) {
    throw new Error(`${release} already points to ${releaseDigest}; expected ${sourceDigest}`)
  }
  if (!releaseDigest) {
    execFileSync('docker', ['buildx', 'imagetools', 'create', '--tag', release, `${source}@${sourceDigest}`], { stdio: 'inherit' })
  }
  if (digest(release) !== sourceDigest) throw new Error(`${release} digest changed during promotion`)
  verify(release)
  process.stdout.write(`${release} -> ${sourceDigest}\n`)
}
