// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator execution engine: handler dispatch, support gating, and rollback signaling.

import { describe, it, expect, vi } from 'vitest'
import type { TxClient } from '../../../../apps/api/src/db.js'
import { isExecutable, unsupportedSteps, applyPlanSteps, StepExecutionError } from '../../../../apps/api/src/operator-execute.js'

function clientReturning(rowsByCall: unknown[][]): TxClient {
  const query = vi.fn()
  for (const rows of rowsByCall) query.mockResolvedValueOnce({ rows })
  query.mockResolvedValue({ rows: [] })
  return { query } as unknown as TxClient
}

describe('execution support gating', () => {
  it('recognizes executable capabilities', () => {
    expect(isExecutable('createZone')).toBe(true)
    expect(isExecutable('registerApplication')).toBe(true)
    expect(isExecutable('grantAccess')).toBe(true)
    expect(isExecutable('rotateApplicationSecret')).toBe(true)
    expect(isExecutable('listZones')).toBe(true)
    expect(isExecutable('explainAccess')).toBe(true)
    expect(isExecutable('connectProvider')).toBe(false)
    expect(isExecutable('defineResource')).toBe(false)
  })

  it('identifies steps without an execution handler', () => {
    const steps = [
      { id: 's1', capability: 'createZone', args: { name: 'Prod' } },
      { id: 's2', capability: 'connectProvider', args: {} },
    ]
    expect(unsupportedSteps(steps).map((s) => s.id)).toEqual(['s2'])
  })
})

describe('applyPlanSteps', () => {
  it('applies a createZone step and returns a ledger-safe detail', async () => {
    // createZoneRecord first checks slug availability, then inserts.
    const client = clientReturning([[], [{ id: 'z-new', name: 'Prod', slug: 'prod' }]])
    const result = await applyPlanSteps(client, 'z1', [{ id: 's1', capability: 'createZone', args: { name: 'Prod' } }])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 's1', capability: 'createZone' })
    expect(result[0].detail).toContain('Prod')
    expect(result[0].output).toMatchObject({ zone_id: 'z-new' })
    // The step carries the audit entity so the execution is recorded per entity in
    // Caracal's own admin audit log, in the new zone's chain.
    expect(result[0].audit).toEqual({ entityType: 'zones', entityId: 'z-new', zoneId: 'z-new' })
  })

  it('returns the issued secret as a one-time output, never in the detail', async () => {
    const client = clientReturning([[{ id: 'app-new', name: 'worker' }]])
    const result = await applyPlanSteps(client, 'z1', [{ id: 's1', capability: 'registerApplication', args: { name: 'worker' } }])
    expect(result[0].output?.client_secret).toMatch(/^cs_/)
    expect(result[0].detail).not.toContain('cs_')
  })

  it('throws StepExecutionError carrying the failed step on handler failure', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('insert failed')),
    } as unknown as TxClient
    await expect(applyPlanSteps(client, 'z1', [{ id: 's1', capability: 'createZone', args: { name: 'Prod' } }])).rejects.toMatchObject({
      name: 'StepExecutionError',
      stepId: 's1',
      capability: 'createZone',
    })
  })

  it('refuses a step whose capability has no handler', async () => {
    const client = clientReturning([])
    await expect(applyPlanSteps(client, 'z1', [{ id: 's1', capability: 'connectProvider', args: {} }])).rejects.toBeInstanceOf(
      StepExecutionError,
    )
  })

  it('rotates an application secret and returns it as a one-time output', async () => {
    const client = clientReturning([[{ id: 'app-1', name: 'worker' }]])
    const result = await applyPlanSteps(client, 'z1', [
      { id: 's1', capability: 'rotateApplicationSecret', args: { application_id: 'app-1' } },
    ])
    expect(result[0].output?.client_secret).toMatch(/^cs_/)
    expect(result[0].detail).toContain('app-1')
    expect(result[0].detail).not.toContain('cs_')
  })

  it('fails a rotation for a missing application with StepExecutionError', async () => {
    const client = clientReturning([[]]) // UPDATE ... RETURNING yields no row
    await expect(
      applyPlanSteps(client, 'z1', [{ id: 's1', capability: 'rotateApplicationSecret', args: { application_id: 'gone' } }]),
    ).rejects.toBeInstanceOf(StepExecutionError)
  })

  it('grants access when the application and resource validate', async () => {
    // createDelegatedGrant: first the refs lookup, then the insert.
    const client = clientReturning([[{ application_exists: true, resource_scopes: ['invoices:read'] }], [{ id: 'grant-1' }]])
    const result = await applyPlanSteps(client, 'z1', [
      {
        id: 's1',
        capability: 'grantAccess',
        args: { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:read'] },
      },
    ])
    expect(result[0].output).toMatchObject({ grant_id: 'grant-1' })
    expect(result[0].detail).toContain('invoices:read')
  })

  it('fails a grant whose scopes exceed the resource with StepExecutionError', async () => {
    const client = clientReturning([[{ application_exists: true, resource_scopes: ['invoices:read'] }]])
    await expect(
      applyPlanSteps(client, 'z1', [
        {
          id: 's1',
          capability: 'grantAccess',
          args: { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:write'] },
        },
      ]),
    ).rejects.toBeInstanceOf(StepExecutionError)
  })

  it('reads zones and returns them as live output', async () => {
    const client = clientReturning([[{ id: 'z-1', name: 'Prod', slug: 'prod' }]])
    const result = await applyPlanSteps(client, 'z1', [{ id: 's1', capability: 'listZones', args: {} }])
    expect(result[0].output?.zones).toEqual([{ id: 'z-1', name: 'Prod', slug: 'prod' }])
    expect(result[0].detail).toContain('1 zone')
    // A read changes nothing, so it carries no audit entity and is never recorded as a mutation.
    expect(result[0].audit).toBeUndefined()
  })

  it('explains access from active grants as live output', async () => {
    const client = clientReturning([[{ application_id: 'app-1', resource_id: 'res-1', user_id: 'user-1', scopes: ['invoices:read'] }]])
    const result = await applyPlanSteps(client, 'z1', [{ id: 's1', capability: 'explainAccess', args: { application_id: 'app-1' } }])
    expect(Array.isArray(result[0].output?.grants)).toBe(true)
    expect(result[0].detail).toContain('grant')
  })
})
