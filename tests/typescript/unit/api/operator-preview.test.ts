// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the read-only Operator execution preview.

import { describe, it, expect, vi } from 'vitest'
import { previewPlan, type PreviewQueryable } from '../../../../apps/api/src/operator-preview.js'

// A queryable whose existence checks are scripted per call. Each entry is the rows
// array returned for the next db.query invocation, in order.
function scriptedDb(results: { rows: unknown[] }[]): PreviewQueryable {
  const query = vi.fn()
  for (const result of results) query.mockResolvedValueOnce(result)
  query.mockResolvedValue({ rows: [] })
  return { query } as unknown as PreviewQueryable
}

describe('previewPlan', () => {
  it('returns catalog diagnostics without reading state when validation fails', async () => {
    const db = scriptedDb([])
    const result = await previewPlan(db, 'z1', {
      summary: 'bad',
      steps: [{ id: 's1', capability: 'nope', args: {} }],
    })
    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(0)
    expect(result.diagnostics[0]).toMatchObject({ code: 'unknown_capability' })
    expect(db.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('classifies a create when the name is free', async () => {
    const db = scriptedDb([{ rows: [] }]) // providers name lookup → not taken
    const result = await previewPlan(db, 'z1', {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    })
    expect(result.ok).toBe(true)
    expect(result.mutating).toBe(true)
    expect(result.steps[0]).toMatchObject({ id: 's1', effect: 'create' })
    expect(result.steps[0].detail).toContain('GitHub')
  })

  it('classifies an exists when the name is taken', async () => {
    const db = scriptedDb([{ rows: [{ one: 1 }] }]) // providers name lookup → taken
    const result = await previewPlan(db, 'z1', {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    })
    expect(result.steps[0]).toMatchObject({ effect: 'exists' })
  })

  it('treats read capabilities as read_only without querying state', async () => {
    const db = scriptedDb([])
    const result = await previewPlan(db, 'z1', {
      summary: 'Audit',
      steps: [{ id: 's1', capability: 'explainAccess', args: { application_id: 'app-1' } }],
    })
    expect(result.steps[0]).toMatchObject({ effect: 'read_only' })
    expect(db.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('blocks a grant whose application is missing and marks the plan not ok', async () => {
    const db = scriptedDb([{ rows: [] }]) // application id lookup → missing
    const result = await previewPlan(db, 'z1', {
      summary: 'Grant read',
      steps: [
        {
          id: 's1',
          capability: 'grantAccess',
          args: { application_id: 'app-x', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:read'] },
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.steps[0]).toMatchObject({ effect: 'blocked' })
    expect(result.steps[0].detail).toContain('app-x')
  })

  it('resolves a grant when application and resource are both live', async () => {
    const db = scriptedDb([
      { rows: [{ one: 1 }] }, // application live
      { rows: [{ one: 1 }] }, // resource live
    ])
    const result = await previewPlan(db, 'z1', {
      summary: 'Grant read',
      steps: [
        {
          id: 's1',
          capability: 'grantAccess',
          args: { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:read'] },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.steps[0]).toMatchObject({ effect: 'create' })
    expect(result.steps[0].detail).toContain('invoices:read')
  })

  it('classifies a delete when the application is live, and blocks it when missing', async () => {
    const live = scriptedDb([{ rows: [{ one: 1 }] }]) // application id lookup → live
    const liveResult = await previewPlan(live, 'z1', {
      summary: 'Delete app',
      steps: [{ id: 's1', capability: 'deleteApplication', args: { application_id: 'app-1' } }],
    })
    expect(liveResult.ok).toBe(true)
    expect(liveResult.steps[0]).toMatchObject({ effect: 'delete' })
    expect(liveResult.steps[0].detail).toContain('app-1')

    const missing = scriptedDb([{ rows: [] }]) // application id lookup → missing
    const missingResult = await previewPlan(missing, 'z1', {
      summary: 'Delete app',
      steps: [{ id: 's1', capability: 'deleteApplication', args: { application_id: 'app-x' } }],
    })
    expect(missingResult.ok).toBe(false)
    expect(missingResult.steps[0]).toMatchObject({ effect: 'blocked' })
  })

  it('previews a multi-step plan against live state in order', async () => {
    const db = scriptedDb([
      { rows: [] }, // createZone name free
      { rows: [{ one: 1 }] }, // registerApplication name taken
    ])
    const result = await previewPlan(db, 'z1', {
      summary: 'Stand up',
      steps: [
        { id: 's1', capability: 'createZone', args: { name: 'Production' } },
        { id: 's2', capability: 'registerApplication', args: { name: 'billing-worker' } },
      ],
    })
    expect(result.steps.map((s) => s.effect)).toEqual(['create', 'exists'])
  })
})
