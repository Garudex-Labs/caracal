#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies that a stable release originates from a complete published candidate.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readReleaseConfig } from './releaseInventory.mjs'
import { releaseTags, verifyRemoteReleaseTags } from './releaseTags.mjs'
import { releaseRunName, repoSlug, resumeRunName, resumeWorkflowPath } from './lib/releaseSpec.mjs'

function run(cwd, command, args, options = {}) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', ...options }).trim()
}

export function verifyReleasePromotion(cwd, fromTag, stableTag, requireProductVersion = false) {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$/.test(fromTag ?? '')) throw new Error(`invalid release candidate: ${fromTag}`)
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(stableTag ?? '')) throw new Error(`invalid stable release: ${stableTag}`)
  if (!fromTag.startsWith(`${stableTag}-rc.`)) throw new Error(`${fromTag} does not promote to ${stableTag}`)
  const manifestPath = join(cwd, 'releases', fromTag, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`release candidate manifest not found: ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.mode !== 'rc' || manifest.release !== fromTag) throw new Error(`${manifestPath} is not the ${fromTag} release plan`)
  const validation = ['scripts/validateReleaseManifest.mjs']
  if (requireProductVersion) validation.push('--product-version')
  validation.push(manifestPath)
  execFileSync(process.execPath, validation, { cwd, stdio: 'inherit' })
  execFileSync('git', ['fetch', '--tags', '--quiet', 'origin'], { cwd, stdio: 'inherit' })
  const sourceSha = run(cwd, 'git', ['rev-list', '-n', '1', `refs/tags/${fromTag}`])
  if (!sourceSha) throw new Error(`release candidate tag not found: ${fromTag}`)
  verifyRemoteReleaseTags(cwd, releaseTags(readReleaseConfig(), manifest.version), sourceSha)
  const runs = JSON.parse(
    run(cwd, 'gh', [
      'api',
      `repos/${repoSlug}/actions/workflows/release.yml/runs?event=workflow_dispatch&status=success&head_sha=${sourceSha}&per_page=100`,
    ]),
  ).workflow_runs
  const title = releaseRunName(fromTag, 'publish', sourceSha)
  const publishedByRelease = runs.some(
    (workflow) =>
      workflow.display_title === title &&
      workflow.head_branch === fromTag &&
      workflow.head_sha === sourceSha &&
      workflow.conclusion === 'success',
  )
  const resumeRuns = JSON.parse(
    run(cwd, 'gh', [
      'api',
      `repos/${repoSlug}/actions/workflows/resumeRelease.yml/runs?event=workflow_dispatch&status=success&per_page=100`,
    ]),
  ).workflow_runs
  const resumeTitle = resumeRunName(fromTag, 'publish', sourceSha)
  const publishedByResume = resumeRuns.some(
    (workflow) =>
      workflow.path === resumeWorkflowPath &&
      workflow.display_title === resumeTitle &&
      workflow.head_branch === 'main' &&
      workflow.conclusion === 'success',
  )
  if (!publishedByRelease && !publishedByResume) {
    throw new Error(`${fromTag} has no successful exact-source publication or resume workflow`)
  }
  const published = JSON.parse(run(cwd, 'gh', ['api', `repos/${repoSlug}/releases/tags/${fromTag}`]))
  if (published.prerelease !== true || published.draft === true) throw new Error(`${fromTag} is not a published GitHub prerelease`)
  const evidence = mkdtempSync(join(tmpdir(), 'caracal-promotion-'))
  try {
    execFileSync('gh', ['release', 'download', fromTag, '--repo', repoSlug, '--pattern', 'manifest.json', '--dir', evidence], {
      cwd,
      stdio: 'inherit',
    })
    execFileSync(
      process.execPath,
      ['scripts/validateReleaseManifest.mjs', '--source-sha', sourceSha, '--image-digests', join(evidence, 'manifest.json')],
      { cwd, stdio: 'inherit' },
    )
    execFileSync(process.execPath, ['scripts/verifyOciDigests.mjs', join(evidence, 'manifest.json')], {
      cwd,
      stdio: 'inherit',
    })
  } finally {
    rmSync(evidence, { recursive: true, force: true })
  }
  return manifest
}

function main() {
  const [fromTag, stableTag, flag] = process.argv.slice(2)
  verifyReleasePromotion(process.cwd(), fromTag, stableTag, flag === '--product-version')
  process.stdout.write(`verified promotion ${fromTag} -> ${stableTag}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
