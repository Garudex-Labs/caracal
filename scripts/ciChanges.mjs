#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// PR selection is tested locally; non-PR events always run the complete suite.

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function ciChanges(paths, event) {
  const areas = Object.fromEntries(
    ['typescript', 'go', 'python', 'style', 'docs', 'postgres', 'helm', 'infra', 'workflows'].map((area) => [
      area,
      event !== 'pull_request',
    ]),
  )
  for (const path of paths) {
    const all = /^\.github\/workflows\/test\.yml$|^toolchain\.json$/.test(path)
    if (all) for (const area of Object.keys(areas)) areas[area] = true
    if (/^\.github\/workflows\/|^scripts\/(validateWorkflows|ciChanges)\.mjs$|^scripts\/lib\/releaseSpec\.mjs$/.test(path))
      areas.workflows = true
    if (
      /^apps\/|^packages\/engine\/|^packages\/.*\/ts\/|^tests\/typescript\/|^scripts\/|^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|release\.config\.json|\.pnpmfile\.cjs|eslint\.config\.js|knip\.json|vitest\.config\.ts)$/.test(
        path,
      )
    )
      areas.typescript = true
    if (
      /^services\/|^packages\/.*\/go\/|^tests\/(go|source\/go)\/|^go\.work(\.sum)?$|^scripts\/runGo(Tests|Audit)\.mjs$|^infra\/(healthcheck|postgres\/gosu)\//.test(
        path,
      )
    )
      areas.go = true
    if (
      /^packages\/.*\/python\/|^tests\/python\/|^tests\/shared\/test-utils\/python\/|^scripts\/((python.*|publishPypi)Requirements\.(in|lock)|checkPythonDependencies\.py|runPythonTests\.mjs|setupDev\.mjs)$/.test(
        path,
      )
    )
      areas.python = true
    if (
      /^docs\/|^scripts\/docsVersion\.mjs$|^\.github\/workflows\/(deploy|release)\.yml$|^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(
        path,
      )
    )
      areas.docs = true
    if (
      /^infra\/postgres\/|^apps\/api\/|^packages\/engine\/|^packages\/.*\/ts\/|^tests\/typescript\/integration\/|^tests\/shared\/test-utils\/typescript\/|^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(
        path,
      )
    )
      areas.postgres = true
    if (/^infra\/helm\//.test(path)) areas.helm = true
    if (
      /^infra\/(docker|scripts|tofu|redis|secrets|healthcheck|containerPlatform)\/|^deploy\/|^\.github\/workflows\/deployAzure\.yml$|^(\.dockerignore|\.pnpmfile\.cjs|install\.sh|install\.ps1)$/.test(
        path,
      )
    )
      areas.infra = true
    if (areas.typescript || areas.go || areas.python || areas.infra || areas.helm || /^(CONTRIBUTING\.md|\.prettier.*)$/.test(path))
      areas.style = true
  }
  return areas
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const event = process.env.EVENT_NAME
  const paths =
    event === 'pull_request'
      ? execFileSync('git', ['diff', '--no-renames', '--name-only', process.env.BASE_SHA, process.env.HEAD_SHA], { encoding: 'utf8' })
          .trim()
          .split('\n')
      : []
  const output =
    Object.entries(ciChanges(paths, event))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  else process.stdout.write(output)
}
