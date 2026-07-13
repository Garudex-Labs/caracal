#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Dispatches the trusted PyPI publisher and deterministically tracks its run to completion.

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { commitPattern, publishTagPattern, pypiRunName, pypiWorkflowPath } from './lib/releaseSpec.mjs'

const discoverDeadlineMs = 10 * 60 * 1000
const discoverIntervalMs = 10_000
const dispatchWindowMs = 2 * 60 * 1000

export function matchDispatchedRun(runs, title, branch, windowStart) {
  return (
    runs
      .filter(
        (run) =>
          run.display_title === title &&
          run.head_branch === branch &&
          run.event === 'workflow_dispatch' &&
          Date.parse(run.created_at) >= windowStart,
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null
  )
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...options })
}

async function main() {
  const [tag, sha] = process.argv.slice(2)
  const branch = process.env.DEFAULT_BRANCH
  const repository = process.env.GH_REPO
  if (!publishTagPattern.test(tag ?? '') || !commitPattern.test(sha ?? '') || !branch || !repository) {
    throw new Error('usage: dispatchPypiRelease.mjs <release-tag> <source-sha> with GH_REPO and DEFAULT_BRANCH set')
  }
  const windowStart = Date.now() - dispatchWindowMs
  gh(
    [
      'workflow',
      'run',
      'publishPypi.yml',
      '--ref',
      branch,
      '-f',
      'package=all',
      '-f',
      'dryRun=false',
      '-f',
      'runner=ubuntu-24.04',
      '-f',
      `releaseTag=${tag}`,
      '-f',
      `releaseSha=${sha}`,
    ],
    { stdio: 'inherit' },
  )
  const title = pypiRunName(tag, 'publish')
  const deadline = Date.now() + discoverDeadlineMs
  let run = null
  while (!run) {
    const listing = JSON.parse(
      gh([
        'api',
        '-X',
        'GET',
        `repos/${repository}/actions/workflows/publishPypi.yml/runs`,
        '-f',
        'event=workflow_dispatch',
        '-f',
        `branch=${branch}`,
        '-f',
        'per_page=30',
      ]),
    )
    run = matchDispatchedRun(listing.workflow_runs ?? [], title, branch, windowStart)
    if (run) break
    if (Date.now() >= deadline) throw new Error(`no ${title} run appeared on ${branch} after dispatch`)
    process.stdout.write(`waiting for ${title} to appear on ${branch}...\n`)
    await delay(discoverIntervalMs)
  }
  process.stdout.write(`tracking PyPI publish run ${run.id}: ${run.html_url}\n`)
  gh(['run', 'watch', String(run.id), '--exit-status', '--interval', '30'], { stdio: 'inherit' })
  const finished = JSON.parse(gh(['api', `repos/${repository}/actions/runs/${run.id}`]))
  if (
    finished.display_title !== title ||
    finished.head_branch !== branch ||
    finished.path !== pypiWorkflowPath ||
    finished.status !== 'completed' ||
    finished.conclusion !== 'success'
  ) {
    throw new Error(`PyPI publish run ${run.id} did not complete successfully: ${JSON.stringify(finished)}`)
  }
  process.stdout.write(`PyPI publish run ${run.id} completed successfully\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
