/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for the audit presentation model that turns raw events into console copy.
*/
import { describe, expect, it } from 'vitest'

import {
  auditActor,
  auditDelegationChain,
  auditEntities,
  auditEventLabel,
  auditReason,
  auditSummary,
} from '../../../../apps/web/src/lib/auditPresentation'

function event(eventType: string, decision: string | null, meta: Record<string, unknown>) {
  return { event_type: eventType, decision, metadata_json: meta }
}

describe('auditEventLabel', () => {
  it('labels known event types', () => {
    expect(auditEventLabel('token_exchange')).toBe('Token issued')
    expect(auditEventLabel('control.invoke')).toBe('Control command')
    expect(auditEventLabel('jti_collision')).toBe('Token ID collision')
  })

  it('humanizes unknown types', () => {
    expect(auditEventLabel('custom_thing')).toBe('custom thing')
  })
})

describe('auditActor', () => {
  it('prefers the application name over ids', () => {
    expect(auditActor(event('token_exchange', 'allow', { application_name: 'Son of Anton', application_id: 'app-1' }))).toBe('Son of Anton')
  })

  it('falls back to application id, then subject', () => {
    expect(auditActor(event('gateway_resource_request', 'allow', { application_id: 'app-1' }))).toBe('app-1')
    expect(auditActor(event('control.invoke', 'allow', { subject: 'richard.hendricks' }))).toBe('richard.hendricks')
    expect(auditActor(event('replay_detected', 'deny', {}))).toBeNull()
  })
})

describe('auditSummary', () => {
  it('narrates an issued credential with delegation hops', () => {
    const summary = auditSummary(
      event('token_exchange', 'allow', {
        application_name: 'Son of Anton',
        resource: 'resource://pipernet',
        delegation_hop_count: 2,
      }),
    )
    expect(summary).toBe('Son of Anton was issued a credential for resource://pipernet via delegation (2 hops)')
  })

  it('narrates a denial with its humanized reason', () => {
    const summary = auditSummary(
      event('exchange_denied', 'deny', {
        application_name: 'Fiona',
        resource: 'resource://not-hotdog',
        reason: 'no_provider_grant',
      }),
    )
    expect(summary).toBe('Fiona was denied a credential for resource://not-hotdog - The user has not granted this provider')
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
        application_name: 'Son of Anton',
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
    const reason = auditReason(event('exchange_denied', 'deny', { reason: 'no_active_policy_set' }))
    expect(reason?.label).toBe('The zone has no active policy set')
    expect(reason?.hint).toContain('Activate a policy set')
  })

  it('humanizes unknown codes without a hint', () => {
    const reason = auditReason(event('exchange_denied', 'deny', { reason: 'quota_exceeded' }))
    expect(reason).toEqual({ label: 'quota exceeded', hint: null })
  })

  it('returns null when no reason is recorded', () => {
    expect(auditReason(event('token_exchange', 'allow', {}))).toBeNull()
  })
})

describe('auditEntities', () => {
  it('extracts linked application, resource, agent, and delegation entities', () => {
    const entities = auditEntities(
      event('token_exchange', 'allow', {
        application_id: 'app-1',
        application_name: 'Son of Anton',
        resource: 'resource://pipernet',
        agent_session_id: 'agent-7',
        delegation_edge_id: 'edge-3',
      }),
    )
    expect(entities).toEqual([
      { kind: 'application', id: 'app-1', label: 'Son of Anton' },
      { kind: 'resource', id: 'resource://pipernet', label: 'resource://pipernet' },
      { kind: 'agent', id: 'agent-7', label: 'agent-7' },
      { kind: 'delegation', id: 'edge-3', label: 'edge-3' },
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
      { applicationId: 'app-1', agentSessionId: 'agent-1', delegationEdgeId: 'edge-1' },
      { applicationId: 'app-2', agentSessionId: null, delegationEdgeId: null },
    ])
  })

  it('returns an empty chain when none was recorded', () => {
    expect(auditDelegationChain(event('token_exchange', 'allow', {}))).toEqual([])
  })
})
