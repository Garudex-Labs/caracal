/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for the audit presentation model that turns raw events into console copy.
*/
import { describe, expect, it } from 'vitest'

import {
  AUDIT_CATEGORIES,
  auditActor,
  auditCategory,
  auditDelegationChain,
  auditEntities,
  auditEventLabel,
  auditReason,
  auditSummary,
} from '../../../../apps/web/src/lib/auditPresentation'

function event(eventType: string, decision: string | null, meta: Record<string, unknown>, evaluationStatus?: string | null) {
  return { event_type: eventType, decision, evaluation_status: evaluationStatus ?? null, metadata_json: meta }
}

describe('auditEventLabel', () => {
  it('labels known event types', () => {
    expect(auditEventLabel('token_exchange')).toBe('Token issued')
    expect(auditEventLabel('control.invoke')).toBe('Control command')
    expect(auditEventLabel('jti_collision')).toBe('Token ID collision')
    expect(auditEventLabel('step_up_issued')).toBe('Approval requested')
  })

  it('labels a denied exchange as a denial, never an issuance', () => {
    expect(auditEventLabel('token_exchange', 'deny')).toBe('Token denied')
    expect(auditEventLabel('token_exchange', 'allow')).toBe('Token issued')
  })

  it('labels approval decisions by their verdict', () => {
    expect(auditEventLabel('step_up_decided', 'approved')).toBe('Approval granted')
    expect(auditEventLabel('step_up_decided', 'rejected')).toBe('Approval rejected')
  })

  it('labels workload launches by their decision', () => {
    expect(auditEventLabel('run_launch', 'allow')).toBe('Workload launch')
    expect(auditEventLabel('run_launch', 'deny')).toBe('Workload launch denied')
  })

  it('humanizes unknown types', () => {
    expect(auditEventLabel('custom_thing')).toBe('custom thing')
  })
})

describe('auditCategory', () => {
  it('assigns every emitted event type to exactly one domain', () => {
    expect(auditCategory('token_exchange')?.id).toBe('authority')
    expect(auditCategory('run_launch')?.id).toBe('authority')
    expect(auditCategory('gateway_resource_request')?.id).toBe('resource')
    expect(auditCategory('step_up_issued')?.id).toBe('approvals')
    expect(auditCategory('step_up_decided')?.id).toBe('approvals')
    expect(auditCategory('step_up_consumed')?.id).toBe('approvals')
    expect(auditCategory('replay_detected')?.id).toBe('security')
    expect(auditCategory('jti_collision')?.id).toBe('security')
    expect(auditCategory('control.invoke')?.id).toBe('control')
    expect(auditCategory('unknown_event')).toBeNull()
  })

  it('keeps category type lists disjoint', () => {
    const seen = new Set<string>()
    for (const category of AUDIT_CATEGORIES) {
      for (const type of category.types) {
        expect(seen.has(type)).toBe(false)
        seen.add(type)
      }
    }
  })
})

describe('auditActor', () => {
  it('prefers the application name over ids', () => {
    expect(auditActor(event('token_exchange', 'allow', { application_name: 'Anton', application_id: 'app-1' }))).toBe('Anton')
  })

  it('falls back to application id, then subject', () => {
    expect(auditActor(event('gateway_resource_request', 'allow', { application_id: 'app-1' }))).toBe('app-1')
    expect(auditActor(event('control.invoke', 'allow', { subject: 'richard.hendricks' }))).toBe('richard.hendricks')
    expect(auditActor(event('replay_detected', 'deny', {}))).toBeNull()
  })

  it('resolves the workload name for run events', () => {
    expect(auditActor(event('run_launch', 'allow', { workload_name: 'Anton', workload_id: 'wl-1' }))).toBe('Anton')
    expect(auditActor(event('run_launch', 'deny', { workload_id: 'wl-1' }))).toBe('wl-1')
  })
})

describe('auditSummary', () => {
  it('narrates an issued credential with delegation hops', () => {
    const summary = auditSummary(
      event('token_exchange', 'allow', {
        application_name: 'Anton',
        resource: 'resource://pipernet',
        delegation_hop_count: 2,
      }),
    )
    expect(summary).toBe('Anton was issued a credential for resource://pipernet via delegation (2 hops)')
  })

  it('narrates a denied exchange with its humanized reason', () => {
    const summary = auditSummary(
      event('token_exchange', 'deny', {
        application_name: 'Fiona',
        resource: 'resource://not-hotdog',
        reason: 'no_provider_grant',
      }),
    )
    expect(summary).toBe('Fiona was denied a credential for resource://not-hotdog - The user has not granted this provider')
  })

  it('derives the denial reason from the evaluation status when metadata has none', () => {
    const summary = auditSummary(
      event('token_exchange', 'deny', { application_name: 'Fiona', resource: 'resource://not-hotdog' }, 'scope_mismatch'),
    )
    expect(summary).toBe('Fiona was denied a credential for resource://not-hotdog - Requested scopes exceed what the resource allows')
  })

  it('narrates approval lifecycle events', () => {
    expect(auditSummary(event('step_up_issued', 'pending', { application_name: 'Anton', tier: 'money' }))).toBe(
      'A human approval hold was raised for Anton (money tier); the exchange waits on an approver',
    )
    expect(
      auditSummary(
        event('step_up_decided', 'rejected', {
          application_name: 'Anton',
          approver_subject_id: 'user:monica.hall@piedpiper.example',
        }),
      ),
    ).toBe('Approver user:monica.hall@piedpiper.example rejected the hold for Anton')
    expect(auditSummary(event('step_up_consumed', 'consumed', { application_name: 'Anton' }))).toBe(
      'Anton redeemed an approved hold to complete the exchange',
    )
  })

  it('narrates a gateway call with its upstream outcome', () => {
    const summary = auditSummary(
      event('gateway_resource_request', 'allow', {
        application_id: 'app-1',
        resource: 'resource://piperchat',
        method: 'GET',
        upstream_status: 200,
      }),
      'PiperNet AI',
    )
    expect(summary).toBe('PiperNet AI called resource://piperchat (GET) - upstream responded 200')
  })

  it('narrates a gateway transport failure', () => {
    const summary = auditSummary(
      event('gateway_resource_request', 'allow', {
        application_name: 'Anton',
        resource: 'resource://hoolibox',
        error_kind: 'transport_error',
      }),
    )
    expect(summary).toContain('a network error interrupted the upstream call')
  })

  it('narrates control commands with their verdict', () => {
    expect(auditSummary(event('control.invoke', 'allow', { command: 'zone', subcommand: 'list' }))).toBe('Control command zone list ran')
    expect(auditSummary(event('control.invoke', 'deny', { command: 'zone', subcommand: 'purge' }))).toBe(
      'Control command zone purge was refused',
    )
  })
})

describe('auditReason', () => {
  it('maps known deny codes to labels with operator hints', () => {
    const reason = auditReason(event('token_exchange', 'deny', { reason: 'no_active_policy_set' }))
    expect(reason?.label).toBe('The zone has no active policy set')
    expect(reason?.hint).toContain('Activate a policy set')
  })

  it('reads STS deny reasons off the evaluation status', () => {
    const reason = auditReason(event('token_exchange', 'deny', {}, 'rate_limited'))
    expect(reason?.label).toBe("The application hit the resource's rate limit")
  })

  it('points a policy verdict deny at the decision trace', () => {
    const reason = auditReason(event('token_exchange', 'deny', {}, 'complete'))
    expect(reason?.label).toBe('Denied by policy')
    expect(reason?.hint).toContain('decision trace')
  })

  it('humanizes unknown codes without a hint', () => {
    const reason = auditReason(event('token_exchange', 'deny', { reason: 'quota_exceeded' }))
    expect(reason).toEqual({ label: 'quota exceeded', hint: null })
  })

  it('returns null when no reason is recorded', () => {
    expect(auditReason(event('token_exchange', 'allow', {}))).toBeNull()
    expect(auditReason(event('gateway_resource_request', 'allow', {}))).toBeNull()
  })
})

describe('auditEntities', () => {
  it('extracts linked application, resource, Session, and Delegation entities', () => {
    const entities = auditEntities(
      event('token_exchange', 'allow', {
        application_id: 'app-1',
        application_name: 'Anton',
        resource: 'resource://pipernet',
        agent_session_id: 'agent-7',
        delegation_edge_id: 'edge-3',
      }),
    )
    expect(entities).toEqual([
      { kind: 'application', id: 'app-1', label: 'Anton' },
      { kind: 'resource', id: 'resource://pipernet', label: 'resource://pipernet' },
      { kind: 'session', id: 'agent-7', label: 'agent-7' },
      { kind: 'delegation', id: 'edge-3', label: 'edge-3' },
    ])
  })

  it('extracts provider and approval-hold entities', () => {
    const entities = auditEntities(event('gateway_resource_request', 'allow', { provider_id: 'prov-1', challenge_id: 'chal-9' }))
    expect(entities).toEqual([
      { kind: 'provider', id: 'prov-1', label: 'prov-1' },
      { kind: 'approval', id: 'chal-9', label: 'chal-9' },
    ])
  })

  it('uses the control client id as the application entity', () => {
    expect(auditEntities(event('control.invoke', 'allow', { client_id: 'ctl-1' }))).toEqual([
      { kind: 'application', id: 'ctl-1', label: 'ctl-1' },
    ])
  })
})

describe('auditDelegationChain', () => {
  it('reads recorded hops and tolerates malformed entries', () => {
    const chain = auditDelegationChain(
      event('token_exchange', 'allow', {
        delegation_chain: [
          { application_id: 'app-1', agent_session_id: 'agent-1', delegation_edge_id: 'edge-1' },
          'garbage',
          { application_id: 'app-2' },
        ],
      }),
    )
    expect(chain).toEqual([
      { applicationId: 'app-1', sessionId: 'agent-1', delegationEdgeId: 'edge-1' },
      { applicationId: 'app-2', sessionId: null, delegationEdgeId: null },
    ])
  })

  it('returns an empty chain when none was recorded', () => {
    expect(auditDelegationChain(event('token_exchange', 'allow', {}))).toEqual([])
  })
})
