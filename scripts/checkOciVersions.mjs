#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Rejects release image and chart versions that already exist in an OCI registry.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chartExists, imageExists } from './lib/oci.mjs'
import { chartRef, imageRef, ociRegistry } from './lib/releaseSpec.mjs'

function parseArgs(argv) {
  const artifacts = []
  let versionOverride = ''
  let all = false
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--version':
        if (!argv[index + 1]) throw new Error('--version requires a value')
        versionOverride = argv[index + 1].replace(/^v/, '')
        index += 1
        break
      case '--image':
        if (!argv[index + 1]) throw new Error('--image requires a reference')
        artifacts.push({ kind: 'image', reference: argv[index + 1] })
        index += 1
        break
      case '--chart':
        if (!argv[index + 1] || !argv[index + 2]) throw new Error('--chart requires a reference and version')
        artifacts.push({ kind: 'chart', reference: argv[index + 1], version: argv[index + 2] })
        index += 2
        break
      case '--all': {
        all = true
        break
      }
      default:
        throw new Error(`unknown argument: ${argv[index]}`)
    }
  }
  if (all) {
    const config = JSON.parse(readFileSync(resolve('release.config.json'), 'utf8'))
    const version = versionOverride || config.product.version
    for (const image of config.product.containers) {
      artifacts.push({ kind: 'image', reference: imageRef(image.name, `v${version}`, ociRegistry()) })
    }
    artifacts.push({ kind: 'chart', reference: `oci://${chartRef(ociRegistry())}`, version })
  }
  if (artifacts.length === 0) throw new Error('specify --all, --image, or --chart')
  return artifacts
}

for (const artifact of parseArgs(process.argv.slice(2))) {
  const published =
    artifact.kind === 'image' ? await imageExists(artifact.reference) : await chartExists(artifact.reference, artifact.version)
  const label = artifact.kind === 'image' ? artifact.reference : `${artifact.reference}:${artifact.version}`
  if (published) throw new Error(`release artifact already published: ${label}`)
  process.stdout.write(`unpublished: ${label}\n`)
}
