// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Regression coverage for the console application rename control flow.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../../../../apps/web/src/routes/$accountId.$orgId.$zoneId.app.applications.tsx', import.meta.url),
  'utf8',
)

function region(start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from, `missing anchor: ${start}`).toBeGreaterThanOrEqual(0)
  const to = source.indexOf(end, from)
  expect(to, `missing anchor: ${end}`).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe('application rename control flow', () => {
  it('resolves the rename submitter with a success flag instead of rejecting', () => {
    const submitter = region('onRename={async (name) => {', 'onRotate=')
    expect(submitter).toContain('return true;')
    expect(submitter).toContain('return false;')
    expect(submitter).not.toContain('throw')
  })

  it('closes the rename editor only after a successful rename', () => {
    const commit = region('function commitRename()', '<DetailGroup title="Identity">')
    expect(commit).toContain('void onRename(nextName).then((renamed) => {')
    expect(commit).toContain('if (renamed) setEditing(false);')
  })
})
