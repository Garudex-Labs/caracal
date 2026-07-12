// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests workflow invariant validation and release run-name and provenance contracts.

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkCallerInputs, checkCallerPermissions, validateWorkflow, validateWorkflows } from '../../../../scripts/validateWorkflows.mjs'
import {
  pypiRunName,
  pypiRunNameTemplate,
  releaseRunName,
  releaseRunNameTemplate,
  resumeRunName,
  resumeRunNameTemplate,
} from '../../../../scripts/lib/releaseSpec.mjs'
import { hasReleaseProvenance } from '../../../../scripts/verifyAttestation.mjs'
import { isAuthorized, parseMaintainers } from '../../../../scripts/authorizeReleaseActor.mjs'
import { matchDispatchedRun } from '../../../../scripts/dispatchPypiRelease.mjs'

const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))

function renderTemplate(template, { tag, mode, sha }) {
  return template.replace(/\$\{\{ ([^}]+) \}\}/g, (_, expression) => {
    if (expression.includes('dryRun &&')) return mode
    if (expression.includes('sourceSha')) return sha
    return tag
  })
}

describe('workflow invariants', () => {
  it('accepts the committed workflows', () => {
    expect(validateWorkflows(join(root, '.github', 'workflows'))).toEqual([])
  })

  it('rejects caller jobs missing permissions requested by a called workflow', () => {
    const called = {
      permissions: { contents: 'read' },
      jobs: {
        publish: { permissions: { contents: 'read', 'id-token': 'write' } },
      },
    }
    const caller = { permissions: { contents: 'read' }, with: { package: 'all' } }
    const findings = checkCallerPermissions(caller, {}, called, 'release.yml job publishNpmPackages')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('id-token: write')
  })

  it('accepts caller jobs granting a superset of nested permissions', () => {
    const called = {
      jobs: {
        publish: { permissions: { contents: 'read', 'id-token': 'write' } },
        preflight: { permissions: { contents: 'read' } },
      },
    }
    const caller = { permissions: { contents: 'write', 'id-token': 'write' } }
    expect(checkCallerPermissions(caller, {}, called, 'context')).toEqual([])
  })

  it('rejects undeclared and missing workflow_call inputs', () => {
    const called = {
      on: { workflow_call: { inputs: { package: { required: true }, dryRun: {} } } },
    }
    const undeclared = checkCallerInputs({ with: { package: 'all', bogus: true } }, called, 'context')
    expect(undeclared).toHaveLength(1)
    expect(undeclared[0]).toContain('bogus')
    const missing = checkCallerInputs({ with: { dryRun: true } }, called, 'context')
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain('package')
  })

  it('rejects run-name drift on release workflows', () => {
    const workflow = { 'run-name': 'Caracal renamed', on: { workflow_dispatch: { inputs: {} } }, jobs: {} }
    const findings = validateWorkflow('release.yml', workflow, {})
    expect(findings.some((finding) => finding.includes('run-name'))).toBe(true)
    expect(findings.some((finding) => finding.includes("input 'releaseVersion'"))).toBe(true)
  })

  it('rejects gh usage without checkout or GH_REPO', () => {
    const workflow = {
      concurrency: { group: 'x', 'cancel-in-progress': false },
      jobs: {
        watch: {
          if: "github.repository == 'Garudex-Labs/caracal'",
          'timeout-minutes': 5,
          permissions: { contents: 'read' },
          steps: [{ run: 'gh run watch 1' }],
        },
      },
    }
    const findings = validateWorkflow('publishNpm.yml', workflow, {})
    expect(findings.some((finding) => finding.includes('GH_REPO'))).toBe(true)
  })

  it('rejects unpinned third-party actions', () => {
    const workflow = {
      concurrency: { group: 'x', 'cancel-in-progress': false },
      jobs: {
        build: {
          if: "github.repository == 'Garudex-Labs/caracal'",
          'timeout-minutes': 5,
          permissions: { contents: 'read' },
          steps: [{ uses: 'actions/checkout@v7' }],
        },
      },
    }
    const findings = validateWorkflow('publishNpm.yml', workflow, {})
    expect(findings.some((finding) => finding.includes('pinned'))).toBe(true)
  })
})

describe('run-name contracts', () => {
  const values = { tag: 'v9.9.9-rc.1', mode: 'dry-run', sha: 'a'.repeat(40) }

  it('release run-name template matches the script format', () => {
    expect(renderTemplate(releaseRunNameTemplate, values)).toBe(releaseRunName(values.tag, values.mode, values.sha))
  })

  it('resume run-name template matches the script format', () => {
    expect(renderTemplate(resumeRunNameTemplate, values)).toBe(resumeRunName(values.tag, values.mode, values.sha))
  })

  it('pypi run-name template matches the script format', () => {
    expect(renderTemplate(pypiRunNameTemplate, values)).toBe(pypiRunName(values.tag, values.mode))
  })
})

describe('release provenance matching', () => {
  const sha = 'b'.repeat(40)
  const results = [
    {
      verificationResult: {
        signature: {
          certificate: {
            sourceRepositoryURI: 'https://github.com/Garudex-Labs/caracal',
            sourceRepositoryDigest: sha,
            sourceRepositoryRef: 'refs/tags/v9.9.9',
          },
        },
      },
    },
  ]

  it('accepts exact source provenance', () => {
    expect(hasReleaseProvenance(results, sha, 'v9.9.9')).toBe(true)
  })

  it('rejects provenance for another commit or tag', () => {
    expect(hasReleaseProvenance(results, 'c'.repeat(40), 'v9.9.9')).toBe(false)
    expect(hasReleaseProvenance(results, sha, 'v9.9.8')).toBe(false)
    expect(hasReleaseProvenance([], sha, 'v9.9.9')).toBe(false)
  })
})

describe('release actor authorization', () => {
  const maintainers = parseMaintainers('# registry\n@rawx18 @slo-pix\n')

  it('parses and matches maintainers case-insensitively', () => {
    expect(maintainers).toEqual(['rawx18', 'slo-pix'])
    expect(isAuthorized('RawX18', maintainers)).toBe(true)
    expect(isAuthorized('mallory', maintainers)).toBe(false)
  })

  it('allows the GitHub Actions bot only when explicitly enabled', () => {
    expect(isAuthorized('github-actions[bot]', maintainers)).toBe(false)
    expect(isAuthorized('github-actions[bot]', maintainers, { allowGitHubBot: true })).toBe(true)
  })
})

describe('pypi dispatch run discovery', () => {
  const title = pypiRunName('v9.9.9', 'publish')
  const windowStart = Date.parse('2026-07-12T10:00:00Z')
  const run = (id, createdAt, overrides = {}) => ({
    id,
    display_title: title,
    head_branch: 'main',
    event: 'workflow_dispatch',
    created_at: createdAt,
    ...overrides,
  })

  it('selects the newest matching run inside the dispatch window', () => {
    const runs = [run(1, '2026-07-12T10:01:00Z'), run(2, '2026-07-12T10:03:00Z'), run(3, '2026-07-12T09:00:00Z')]
    expect(matchDispatchedRun(runs, title, 'main', windowStart)?.id).toBe(2)
  })

  it('ignores runs with a different title, branch, or event', () => {
    const runs = [
      run(1, '2026-07-12T10:01:00Z', { display_title: 'other' }),
      run(2, '2026-07-12T10:01:00Z', { head_branch: 'feature' }),
      run(3, '2026-07-12T10:01:00Z', { event: 'push' }),
    ]
    expect(matchDispatchedRun(runs, title, 'main', windowStart)).toBeNull()
  })
})
