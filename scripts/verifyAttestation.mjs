#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies GitHub build provenance for release subjects against an exact source commit and tag.

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commitPattern, releaseTagPattern, repoSlug, repoUrl } from './lib/releaseSpec.mjs'

export function hasReleaseProvenance(results, sha, tag) {
  return results.some((result) => {
    const certificate = result.verificationResult?.signature?.certificate
    return (
      certificate?.sourceRepositoryURI === repoUrl &&
      certificate?.sourceRepositoryDigest === sha &&
      certificate?.sourceRepositoryRef === `refs/tags/${tag}`
    )
  })
}

export function verifyReleaseProvenance(subject, sha, tag, { oci = false } = {}) {
  const target = oci ? `oci://${subject}` : subject
  const output = execFileSync('gh', ['attestation', 'verify', target, '--repo', repoSlug, '--format', 'json'], { encoding: 'utf8' })
  if (!hasReleaseProvenance(JSON.parse(output), sha, tag)) {
    throw new Error(`${subject} has no release provenance for ${tag} at ${sha}`)
  }
  process.stdout.write(`${subject}: provenance OK for ${tag} at ${sha}\n`)
}

function main() {
  const args = process.argv.slice(2)
  const subjects = []
  let sha = ''
  let tag = ''
  let oci = false
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--sha':
        sha = args[++index] ?? ''
        break
      case '--tag':
        tag = args[++index] ?? ''
        break
      case '--oci':
        oci = true
        break
      default:
        subjects.push(args[index])
    }
  }
  if (!commitPattern.test(sha) || !releaseTagPattern.test(tag) || subjects.length === 0) {
    throw new Error('usage: verifyAttestation.mjs --sha <source-sha> --tag <release-tag> [--oci] <subject...>')
  }
  for (const subject of subjects) verifyReleaseProvenance(subject, sha, tag, { oci })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
