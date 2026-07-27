// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Wire-level integration tests for Operator Plane approval flow:
// Gated token exchange → Admin API inspection, approve/reject decisions → STS retry & consumption.

import { describe, it, expect } from 'vitest'
import '../../../../apps/api/src/fastify-augmentation.js'
import { approvalsRoutes } from '../../../../apps/api/src/routes/approvals.js'
import { buildRouteApp } from '../../../shared/test-utils/typescript/fastify.js'

interface MockApproval {
  id: string
  zone_id: string
  session_id: string
  principal_id: string
  application_id: string | null
  approval_type: string
  tier: string | null
  approver_class: string
  privacy_mode: string
  subject_anchor: string | null
  binding: string
  metadata_json: Record<string, unknown> | null
  decision_reason: string | null
  created_at: string
  expires_at: string
  satisfied_at: string | null
  rejected_at: string | null
  consumed_at: string | null
  approver_subject_id: string | null
  principal_federated: boolean
  prior_approved: number
  prior_rejected: number
  state: string
}

describe('Operator Plane Approval Flow (Wire-Level Integration)', () => {
  const zoneId = 'z-op-plane-1'
  const challengeId = 'ch-op-9988'
  const requesterId = 'user-agent-alpha'

  it('Step 1: Admin lists pending approvals in zone', async () => {
    const { app, db } = buildRouteApp(approvalsRoutes)
    const activeApproval: MockApproval = {
      id: challengeId,
      zone_id: zoneId,
      session_id: 'sess-101',
      principal_id: requesterId,
      application_id: 'app-01',
      approval_type: 'mfa',
      tier: 'tier-2',
      approver_class: 'operator',
      privacy_mode: 'plain',
      subject_anchor: null,
      binding: 'abcd1234efgh5678',
      metadata_json: null,
      decision_reason: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300000).toISOString(),
      satisfied_at: null,
      rejected_at: null,
      consumed_at: null,
      approver_subject_id: null,
      principal_federated: false,
      prior_approved: 0,
      prior_rejected: 0,
      state: 'pending',
    }

    db.query.mockResolvedValueOnce({ rows: [activeApproval] })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: `/v1/zones/${zoneId}/approvals`,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe(challengeId)
    expect(body.items[0].state).toBe('pending')
  })

  it('Step 2: Admin queries approvals counts summary', async () => {
    const { app, db } = buildRouteApp(approvalsRoutes)
    db.query.mockResolvedValueOnce({
      rows: [
        {
          pending: '2',
          approved: '5',
          rejected: '1',
          expired: '0',
          consumed: '10',
        },
      ],
    })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: `/v1/zones/${zoneId}/approvals/counts`,
    })

    expect(res.statusCode).toBe(200)
    const counts = JSON.parse(res.body)
    expect(counts).toEqual({
      pending: 2,
      approved: 5,
      rejected: 1,
      expired: 0,
      consumed: 10,
    })
  })

  it('Step 3: Admin inspects specific approval details', async () => {
    const { app, db } = buildRouteApp(approvalsRoutes)
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: challengeId,
          zone_id: zoneId,
          session_id: 'sess-101',
          principal_id: requesterId,
          approval_type: 'mfa',
          state: 'pending',
        },
      ],
    })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: `/v1/zones/${zoneId}/approvals/${challengeId}`,
    })

    expect(res.statusCode).toBe(200)
    const approval = JSON.parse(res.body)
    expect(approval.id).toBe(challengeId)
    expect(approval.state).toBe('pending')
  })

  it('Step 4: Admin approves pending hold (Approval Path)', async () => {
    const { app, db } = buildRouteApp(approvalsRoutes)
    const satisfiedTimestamp = new Date().toISOString()

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: challengeId,
          session_id: 'sess-101',
          application_id: 'app-01',
          tier: 'tier-2',
          approver_class: 'operator',
          privacy_mode: 'plain',
          subject_anchor: null,
          binding: 'abcd1234efgh5678',
          metadata_json: null,
          satisfied_at: satisfiedTimestamp,
          rejected_at: null,
          decision_reason: 'Approved by admin operator',
          approver_subject_id: 'admin:test-admin',
        },
      ],
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: `/v1/zones/${zoneId}/approvals/${challengeId}/approve`,
      payload: { reason: 'Approved by admin operator' },
    })

    expect(res.statusCode).toBe(200)
    const result = JSON.parse(res.body)
    expect(result.id).toBe(challengeId)
    expect(result.state).toBe('approved')
    expect(result.approver_subject_id).toBe('admin:test-admin')
  })

  it('Step 5: Admin rejects pending hold (Rejection Path)', async () => {
    const { app, db } = buildRouteApp(approvalsRoutes)
    const rejectedTimestamp = new Date().toISOString()

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: challengeId,
          session_id: 'sess-101',
          application_id: 'app-01',
          tier: 'tier-2',
          approver_class: 'operator',
          privacy_mode: 'plain',
          subject_anchor: null,
          binding: 'abcd1234efgh5678',
          metadata_json: null,
          satisfied_at: null,
          rejected_at: rejectedTimestamp,
          decision_reason: 'Security risk detected',
          approver_subject_id: 'admin:test-admin',
        },
      ],
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: `/v1/zones/${zoneId}/approvals/${challengeId}/reject`,
      payload: { reason: 'Security risk detected' },
    })

    expect(res.statusCode).toBe(200)
    const result = JSON.parse(res.body)
    expect(result.id).toBe(challengeId)
    expect(result.state).toBe('rejected')
    expect(result.approver_subject_id).toBe('admin:test-admin')
  })

  it('Step 6: Rejection Path - Approving already settled or expired hold returns 409', async () => {
    const { app, db } = buildRouteApp(approvalsRoutes)
    // UPDATE returns 0 rows, SELECT existing returns state 'approved'
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ approver_class: 'operator', state: 'approved' }] })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: `/v1/zones/${zoneId}/approvals/${challengeId}/approve`,
      payload: { reason: 'Double approve attempt' },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'approval_not_decidable', state: 'approved' })
  })

  it('Step 7: Rejection Path - Operator approving subject-only hold returns 403', async () => {
    const { app, db } = buildRouteApp(approvalsRoutes)
    // UPDATE returns 0 rows, SELECT existing shows approver_class 'subject'
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ approver_class: 'subject', state: 'pending' }] })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: `/v1/zones/${zoneId}/approvals/${challengeId}/approve`,
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'subject_approval_required' })
  })
})
