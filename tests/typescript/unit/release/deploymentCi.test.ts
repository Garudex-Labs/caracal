// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { ciChanges } from '../../../../scripts/ciChanges.mjs'
import { validateWorkflow, validateWorkflows } from '../../../../scripts/validateWorkflows.mjs'

describe('deployment CI coverage', () => {
  it.each(['infra/containerPlatform/topology.yaml', 'deploy/azure/production.yaml', '.dockerignore', 'install.sh', 'install.ps1'])(
    'validates infrastructure when %s changes',
    (path) => {
      expect(ciChanges([path], 'pull_request').infra).toBe(true)
    },
  )
  it.each(['toolchain.json', '.github/workflows/test.yml'])('runs all areas for %s', (path) => {
    expect(Object.values(ciChanges([path], 'pull_request')).every(Boolean)).toBe(true)
  })
  it.each(['push', 'schedule', 'workflow_dispatch', 'merge_group'])('runs the full suite on %s', (event) => {
    expect(Object.values(ciChanges([], event)).every(Boolean)).toBe(true)
  })
  it('does not rebuild deployment images for documentation-only PRs', () => {
    const areas = ciChanges(['docs/src/content/docs/operations/docker-compose.mdx'], 'pull_request')
    expect(areas.docs).toBe(true)
    expect(areas.infra || areas.typescript || areas.go).toBe(false)
  })
  it('gates infrastructure healthcheck and runner changes', () => {
    expect(ciChanges(['infra/healthcheck/main.go'], 'pull_request').go).toBe(true)
    expect(ciChanges(['scripts/runGoTests.mjs'], 'pull_request').go).toBe(true)
    expect(ciChanges(['scripts/runPythonTests.mjs'], 'pull_request').python).toBe(true)
  })
  it.each(['scripts/checkPythonDependencies.py', 'scripts/publishPypiRequirements.lock'])(
    'checks Python dependency changes in %s',
    (path) => {
      expect(ciChanges([path], 'pull_request').python).toBe(true)
    },
  )
  it.each(['scripts/runGoAudit.mjs', 'infra/postgres/gosu/go.mod'])('checks Go supply-chain changes in %s', (path) => {
    expect(ciChanges([path], 'pull_request').go).toBe(true)
  })
  it('includes every test job in the required aggregate status', () => {
    expect(validateWorkflows('.github/workflows')).toEqual([])
    const workflow = parse(readFileSync('.github/workflows/test.yml', 'utf8'))
    workflow.jobs.status.needs = workflow.jobs.status.needs.filter((name: string) => name !== 'helmInstall')
    expect(validateWorkflow('test.yml', workflow, {}).some((message: string) => message.includes("inspect job 'helmInstall'"))).toBe(true)
  })
  it('makes Compose web health depend on readiness and allows the full drain deadline', () => {
    expect(readFileSync('infra/docker/Dockerfile.web', 'utf8')).toContain('HEALTH_PATH=/ready')
    for (const name of ['docker-compose.yml', 'runtime-compose.yml']) {
      const compose = parse(readFileSync(`infra/docker/${name}`, 'utf8'), { merge: true })
      expect(compose.services.web.stop_grace_period).toBe('30s')
    }
  })

  it('normalizes release image time and gates promotion on vulnerability scanning', () => {
    const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'))
    const build = workflow.jobs.images.steps.find((step: { id?: string }) => step.id === 'push')
    expect(build.with['build-args']).toContain('SOURCE_DATE_EPOCH=')
    expect(build.with.labels).toContain('org.opencontainers.image.created=')
    const scan = workflow.jobs.images.steps.find((step: { name?: string }) => step.name === 'Scan source image before promotion')
    expect(scan.with['exit-code']).toBe('1')
    expect(scan.with['ignore-unfixed']).toBe(false)
    expect(scan.with['image-ref']).toContain(':sha-')
    expect(workflow.jobs.verifyPublishedOci.needs).toContain('images')
  })
})
