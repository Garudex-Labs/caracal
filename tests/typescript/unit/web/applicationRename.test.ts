// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Regression coverage for application rename failure handling.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('apps/web/src/routes/$accountId.$orgId.$zoneId.app.applications.tsx', 'utf8')

describe('application rename failure handling', () => {
  it('keeps recoverable rename failures out of the route error boundary', () => {
    expect(source).toContain('return false;')
    expect(source).not.toContain('throw err;')
  })

  it('keeps the rename editor open when the mutation reports failure', () => {
    expect(source).toContain('Promise<boolean>')
    expect(source).toContain('if (renamed) setEditing(false);')
    expect(source).not.toContain('then(() => setEditing(false))')
  })
})
