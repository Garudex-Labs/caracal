#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Statically validates GitHub workflow invariants that only surface at run startup or publish time.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { pypiRunNameTemplate, releaseRunNameTemplate, resumeRunNameTemplate } from './lib/releaseSpec.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseWorkflows = ['release.yml', 'resumeRelease.yml', 'publishNpm.yml', 'publishPypi.yml']

const runNameContracts = {
  'release.yml': releaseRunNameTemplate,
  'resumeRelease.yml': resumeRunNameTemplate,
  'publishPypi.yml': pypiRunNameTemplate,
}

const dispatchInputContracts = {
  'release.yml': ['ref', 'releaseVersion', 'sourceSha', 'dryRun'],
  'resumeRelease.yml': ['releaseTag', 'sourceSha', 'sourceRunId', 'dryRun'],
  'publishPypi.yml': ['package', 'dryRun', 'runner', 'releaseTag', 'releaseSha'],
}

function normalizePermissions(permissions) {
  if (permissions === undefined || permissions === null) return null
  if (permissions === 'read-all') return { '*': 'read' }
  if (permissions === 'write-all') return { '*': 'write' }
  if (typeof permissions === 'object') return { ...permissions }
  return {}
}

function grantSatisfies(granted, scope, level) {
  if (level === 'none') return true
  const allowed = granted[scope] ?? granted['*']
  if (level === 'read') return allowed === 'read' || allowed === 'write'
  return allowed === 'write'
}

export function requestedPermissions(workflow) {
  const workflowLevel = normalizePermissions(workflow.permissions)
  const requested = {}
  for (const job of Object.values(workflow.jobs ?? {})) {
    const effective = normalizePermissions(job.permissions) ?? workflowLevel ?? {}
    for (const [scope, level] of Object.entries(effective)) {
      if (level === 'none') continue
      if (requested[scope] !== 'write') requested[scope] = level
    }
  }
  return requested
}

export function checkCallerPermissions(callerJob, callerWorkflow, calledWorkflow, context) {
  const findings = []
  const granted = normalizePermissions(callerJob.permissions) ?? normalizePermissions(callerWorkflow.permissions)
  if (granted === null) return findings
  for (const [scope, level] of Object.entries(requestedPermissions(calledWorkflow))) {
    if (!grantSatisfies(granted, scope, level)) {
      findings.push(`${context}: called workflow requests '${scope}: ${level}' but the caller job does not grant it`)
    }
  }
  return findings
}

export function checkCallerInputs(callerJob, calledWorkflow, context) {
  const findings = []
  const declared = calledWorkflow.on?.workflow_call?.inputs ?? {}
  for (const key of Object.keys(callerJob.with ?? {})) {
    if (!(key in declared)) findings.push(`${context}: passes undeclared workflow_call input '${key}'`)
  }
  for (const [key, input] of Object.entries(declared)) {
    if (input?.required && !(key in (callerJob.with ?? {}))) {
      findings.push(`${context}: missing required workflow_call input '${key}'`)
    }
  }
  return findings
}

function stepsUsingGh(job) {
  return (job.steps ?? []).filter(
    (step) => typeof step.run === 'string' && /\bgh\s+(api|run|workflow|release|attestation)\b/.test(step.run),
  )
}

function hasCheckout(job) {
  return (job.steps ?? []).some((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))
}

export function validateWorkflow(name, workflow, workflows) {
  const findings = []
  const isReleaseWorkflow = releaseWorkflows.includes(name)
  const expectedRunName = runNameContracts[name]
  if (expectedRunName && workflow['run-name'] !== expectedRunName) {
    findings.push(`${name}: run-name must stay '${expectedRunName}' because release scripts match run titles`)
  }
  for (const required of dispatchInputContracts[name] ?? []) {
    if (!(required in (workflow.on?.workflow_dispatch?.inputs ?? {}))) {
      findings.push(`${name}: workflow_dispatch input '${required}' is required by release tooling`)
    }
  }
  if (isReleaseWorkflow) {
    const concurrency = workflow.concurrency
    if (!concurrency || concurrency['cancel-in-progress'] !== false) {
      findings.push(`${name}: release workflows must define concurrency with cancel-in-progress: false`)
    }
  }
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const context = `${name} job ${jobName}`
    const isCaller = typeof job.uses === 'string'
    if (isCaller && job.uses.startsWith('./')) {
      const target = job.uses.replace(/^\.\/\.github\/workflows\//, '')
      const called = workflows[target]
      if (!called) {
        findings.push(`${context}: uses unknown local workflow ${job.uses}`)
      } else {
        findings.push(...checkCallerPermissions(job, workflow, called, context))
        findings.push(...checkCallerInputs(job, called, context))
      }
    } else if (isCaller) {
      if (!/@[0-9a-f]{40}$/.test(job.uses)) {
        findings.push(`${context}: reusable workflow '${job.uses}' must be pinned to a full commit SHA`)
      }
    } else {
      if (job['timeout-minutes'] === undefined) findings.push(`${context}: missing timeout-minutes`)
      if (isReleaseWorkflow && job.permissions === undefined) findings.push(`${context}: release jobs must declare explicit permissions`)
      const ghSteps = stepsUsingGh(job)
      if (ghSteps.length > 0 && !hasCheckout(job)) {
        const jobEnv = job.env ?? {}
        const covered = 'GH_REPO' in jobEnv || ghSteps.every((step) => 'GH_REPO' in (step.env ?? {}))
        if (!covered) findings.push(`${context}: runs gh without a checkout; set GH_REPO on the job or every gh step`)
      }
      for (const step of job.steps ?? []) {
        if (typeof step.run === 'string' && step.run.includes('dispatchPypiRelease.mjs')) {
          const env = { ...(job.env ?? {}), ...(step.env ?? {}) }
          for (const required of ['GH_REPO', 'DEFAULT_BRANCH', 'GH_TOKEN']) {
            if (!(required in env)) findings.push(`${context}: dispatchPypiRelease.mjs requires env ${required}`)
          }
        }
      }
      for (const step of job.steps ?? []) {
        if (typeof step.uses !== 'string' || step.uses.startsWith('./')) continue
        if (!/@[0-9a-f]{40}$/.test(step.uses.split(' ')[0])) {
          findings.push(`${context}: action '${step.uses}' must be pinned to a full commit SHA`)
        }
      }
    }
    if (isReleaseWorkflow) {
      const condition = typeof job.if === 'string' ? job.if : ''
      if (!condition.includes('github.repository ==')) {
        findings.push(`${context}: release jobs must guard on github.repository`)
      }
    }
  }
  return findings
}

export function validateWorkflows(dir) {
  const workflows = {}
  const findings = []
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))) {
    try {
      workflows[file] = parse(readFileSync(join(dir, file), 'utf8'), { merge: true })
    } catch (error) {
      findings.push(`${file}: does not parse as YAML: ${error.message.split('\n')[0]}`)
    }
  }
  for (const [name, workflow] of Object.entries(workflows)) {
    findings.push(...validateWorkflow(name, workflow, workflows))
  }
  return findings
}

function main() {
  const dir = process.argv[2] ?? join(repoRoot, '.github', 'workflows')
  const findings = validateWorkflows(dir)
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${finding}\n`)
    process.stderr.write(`${findings.length} workflow invariant violation(s)\n`)
    process.exit(1)
  }
  process.stdout.write('workflow invariants ok\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
