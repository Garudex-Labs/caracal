// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Single source of truth for release identity, patterns, registries, and run-name contracts.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const repoSlug = 'Garudex-Labs/caracal'
export const repoUrl = `https://github.com/${repoSlug}`

export const releaseWorkflowPath = '.github/workflows/release.yml'
export const resumeWorkflowPath = '.github/workflows/resumeRelease.yml'
export const pypiWorkflowPath = '.github/workflows/publishPypi.yml'

export const releaseTagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.(?:sha[0-9A-Za-z]+|[0-9]+))?$/
export const publishTagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?$/
export const commitPattern = /^[0-9a-f]{40}$/
export const imageDigestPattern = /^sha256:[0-9a-f]{64}$/

export const registryDefaults = {
  npm: 'https://registry.npmjs.org/',
  pypi: 'https://pypi.org/simple/',
  pypiApi: 'https://pypi.org/pypi/',
  oci: 'ghcr.io/garudex-labs',
  githubReleases: `${repoUrl}/releases/download`,
}

export function ociRegistry() {
  return (process.env.CARACAL_OCI_REGISTRY ?? registryDefaults.oci).replace(/\/$/, '')
}

export function imageRef(name, tag, registry = ociRegistry()) {
  return `${registry.replace(/\/$/, '')}/caracal-${name}:${tag}`
}

export function chartRef(registry = ociRegistry()) {
  return `${registry.replace(/\/$/, '')}/charts/caracal`
}

export const releaseRunNameTemplate =
  "Caracal ${{ inputs.releaseVersion }} ${{ inputs.dryRun && 'dry-run' || 'publish' }} ${{ inputs.sourceSha }}"
export const resumeRunNameTemplate =
  "Caracal ${{ inputs.releaseTag }} resume-${{ inputs.dryRun && 'dry-run' || 'publish' }} ${{ inputs.sourceSha }}"
export const pypiRunNameTemplate =
  "Caracal PyPI ${{ inputs.releaseTag != '' && inputs.releaseTag || github.ref_name }} ${{ inputs.dryRun && 'dry-run' || 'publish' }}"

export function releaseRunName(tag, mode, sha) {
  return `Caracal ${tag} ${mode} ${sha}`
}

export function resumeRunName(tag, mode, sha) {
  return `Caracal ${tag} resume-${mode} ${sha}`
}

export function pypiRunName(tag, mode) {
  return `Caracal PyPI ${tag} ${mode}`
}

export function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(temp, path)
}
