// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
// Reject invalid A/B comparisons before any real service or workload is launched.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const comparator = fileURLToPath(new URL('../../../performance/coordinator/compare.mjs', import.meta.url))

describe('benchmark artifact equivalence', () => {
  it.each(['coordinator/db.js', 'pg'])('rejects an unrelated %s difference before starting services', (key) => {
    const work = mkdtempSync(join(tmpdir(), 'coordinator-artifact-test-'))
    try {
      const before = join(work, 'before'),
        after = join(work, 'after')
      mkdirSync(before)
      mkdirSync(after)
      const manifest = { 'coordinator/db.js': 'same-source', pg: 'same-version' }
      writeFileSync(join(before, 'manifest.json'), JSON.stringify(manifest))
      writeFileSync(join(after, 'manifest.json'), JSON.stringify({ ...manifest, [key]: 'unrelated-change' }))
      const result = spawnSync(process.execPath, [comparator, before, after], {
        env: { ...process.env, PERF_OUTPUT_DIR: join(work, 'output'), PERF_ALLOW_DIFFERENT_SURROUNDING_CODE: '0' },
        encoding: 'utf8',
        timeout: 5000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`Non-performance artifact differs: ${key}`)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
