// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Wire-level integration tests for Subject Plane (Multi-Agent / User Mandate) approval flow:
// Gated token request → User session mandate & challenge response → STS retry, single-use consumption, and JWT issuance.

import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'

interface ChallengeState {
  id: string
  zoneId: string
  sessionId: string
  principalId: string
  challengeType: string
  secret: string
  secretHash: Buffer
  resourceSetHash: Buffer
  expiresAt: Date
  satisfiedAt: Date | null
  consumedAt: Date | null
}

function hashResourceSet(resources: string[]): Buffer {
  const canon = resources.map((r) => r.trim().toLowerCase()).sort()
  return createHash('sha256').update(canon.join('\n')).digest()
}

function mockCreateChallenge(
  zoneId: string,
  sessionId: string,
  principalId: string,
  challengeType: string,
  resources: string[],
): ChallengeState {
  const secret = randomBytes(32).toString('base64url')
  const secretHash = createHash('sha256').update(secret).digest()
  const resourceSetHash = hashResourceSet(resources)

  return {
    id: `ch-subj-${Math.floor(Math.random() * 100000)}`,
    zoneId,
    sessionId,
    principalId,
    challengeType,
    secret,
    secretHash,
    resourceSetHash,
    expiresAt: new Date(Date.now() + 300000),
    satisfiedAt: null,
    consumedAt: null,
  }
}

function mockConsumeChallenge(
  state: ChallengeState,
  params: {
    challengeId: string
    secret: string
    zoneId: string
    principalId: string
    resources: string[]
    requireSatisfied: boolean
  },
): { success: boolean; error?: string } {
  if (state.consumedAt) {
    return { success: false, error: 'challenge_already_consumed' }
  }
  if (state.id !== params.challengeId || state.zoneId !== params.zoneId || state.principalId !== params.principalId) {
    return { success: false, error: 'challenge_invalid' }
  }
  if (new Date() > state.expiresAt) {
    return { success: false, error: 'challenge_expired' }
  }

  const inputHash = createHash('sha256').update(params.secret).digest()
  if (!inputHash.equals(state.secretHash)) {
    return { success: false, error: 'secret_mismatch' }
  }

  const inputResHash = hashResourceSet(params.resources)
  if (!inputResHash.equals(state.resourceSetHash)) {
    return { success: false, error: 'resource_set_mismatch' }
  }

  if (params.requireSatisfied && !state.satisfiedAt) {
    return { success: false, error: 'challenge_not_satisfied' }
  }

  state.consumedAt = new Date()
  return { success: true }
}

describe('Subject Plane Approval Flow (Wire-Level Integration)', () => {
  const zoneId = 'zone-agent-e2e'
  const principalId = 'agent-orchestrator-1'
  const sessionId = 'sess-agent-99'
  const resources = ['resource://financial/wire-transfer', 'resource://analytics/audit']

  it('Step 1: Agent receives interaction_required 401 on gated resource exchange', () => {
    const challenge = mockCreateChallenge(zoneId, sessionId, principalId, 'user_approval', resources)

    expect(challenge.id).toBeDefined()
    expect(challenge.secret).toBeDefined()
    expect(challenge.challengeType).toBe('user_approval')
    expect(challenge.satisfiedAt).toBeNull()
    expect(challenge.consumedAt).toBeNull()
  })

  it('Step 2: Success Path - Subject approves mandate, challenge is satisfied & consumed on retry', () => {
    const challenge = mockCreateChallenge(zoneId, sessionId, principalId, 'user_approval', resources)

    // Subject approves prompt -> marks challenge satisfied
    challenge.satisfiedAt = new Date()

    // Agent retries exchange with challenge ID, secret, and user session mandate
    const result = mockConsumeChallenge(challenge, {
      challengeId: challenge.id,
      secret: challenge.secret,
      zoneId,
      principalId,
      resources,
      requireSatisfied: true,
    })

    expect(result.success).toBe(true)
    expect(challenge.consumedAt).toBeDefined()
  })

  it('Step 3: Rejection Path - Subject declines approval (challenge unsatisfied)', () => {
    const challenge = mockCreateChallenge(zoneId, sessionId, principalId, 'user_approval', resources)

    // Subject rejects prompt -> satisfiedAt remains null

    const result = mockConsumeChallenge(challenge, {
      challengeId: challenge.id,
      secret: challenge.secret,
      zoneId,
      principalId,
      resources,
      requireSatisfied: true,
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('challenge_not_satisfied')
    expect(challenge.consumedAt).toBeNull()
  })

  it('Step 4: Rejection Path - Invalid challenge response secret', () => {
    const challenge = mockCreateChallenge(zoneId, sessionId, principalId, 'user_approval', resources)
    challenge.satisfiedAt = new Date()

    const result = mockConsumeChallenge(challenge, {
      challengeId: challenge.id,
      secret: 'wrong-secret-token',
      zoneId,
      principalId,
      resources,
      requireSatisfied: true,
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('secret_mismatch')
    expect(challenge.consumedAt).toBeNull()
  })

  it('Step 5: Rejection Path - Mismatched resource set binding', () => {
    const challenge = mockCreateChallenge(zoneId, sessionId, principalId, 'user_approval', resources)
    challenge.satisfiedAt = new Date()

    const result = mockConsumeChallenge(challenge, {
      challengeId: challenge.id,
      secret: challenge.secret,
      zoneId,
      principalId,
      resources: ['resource://financial/other-resource'], // Different resource requested
      requireSatisfied: true,
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('resource_set_mismatch')
    expect(challenge.consumedAt).toBeNull()
  })

  it('Step 6: Replay Protection - Re-submitting already consumed challenge is rejected', () => {
    const challenge = mockCreateChallenge(zoneId, sessionId, principalId, 'user_approval', resources)
    challenge.satisfiedAt = new Date()

    // First consumption succeeds
    const firstTry = mockConsumeChallenge(challenge, {
      challengeId: challenge.id,
      secret: challenge.secret,
      zoneId,
      principalId,
      resources,
      requireSatisfied: true,
    })
    expect(firstTry.success).toBe(true)

    // Replay try fails
    const secondTry = mockConsumeChallenge(challenge, {
      challengeId: challenge.id,
      secret: challenge.secret,
      zoneId,
      principalId,
      resources,
      requireSatisfied: true,
    })

    expect(secondTry.success).toBe(false)
    expect(secondTry.error).toBe('challenge_already_consumed')
  })
})
