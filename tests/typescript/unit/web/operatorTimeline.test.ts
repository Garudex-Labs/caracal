// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator timeline presenter: item mapping and plan-state resolution.

import { describe, it, expect } from 'vitest'
import { buildTimeline } from '../../../../apps/web/src/platform/operator/timeline'
import type { OperatorTurn } from '../../../../apps/web/src/platform/api/types'

function turn(partial: Partial<OperatorTurn> & Pick<OperatorTurn, 'seq' | 'kind'>): OperatorTurn {
  return {
    id: `turn-${partial.seq}`,
    conversation_id: 'conv-1',
    role: 'user',
    content: {},
    actor_id: 'actor-1',
    created_at: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

function planTurn(seq: number, steps: { id: string; capability: string; summary: string; mutating: boolean }[]) {
  return turn({ seq, kind: 'plan', role: 'operator', content: { summary: 'Stand up', steps } })
}

describe('buildTimeline', () => {
  it('maps message, note, and error turns into display items', () => {
    const { items } = buildTimeline([
      turn({ seq: 1, kind: 'message', role: 'user', content: { text: 'connect github' } }),
      turn({ seq: 2, kind: 'note', role: 'operator', content: { text: 'here is why' } }),
      turn({ seq: 3, kind: 'error', role: 'system', content: { message: 'failed' } }),
    ])
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ kind: 'message', role: 'user', text: 'connect github' })
    expect(items[1]).toMatchObject({ kind: 'note', text: 'here is why' })
    expect(items[2]).toMatchObject({ kind: 'error', message: 'failed' })
  })

  it('orders items by sequence regardless of input order', () => {
    const { items } = buildTimeline([
      turn({ seq: 3, kind: 'message', content: { text: 'c' } }),
      turn({ seq: 1, kind: 'message', content: { text: 'a' } }),
      turn({ seq: 2, kind: 'message', content: { text: 'b' } }),
    ])
    expect(items.map((i) => (i.kind === 'message' ? i.text : ''))).toEqual(['a', 'b', 'c'])
  })

  it('marks a pending plan as decidable and not executable', () => {
    const { latestPlan } = buildTimeline([planTurn(1, [{ id: 's1', capability: 'createZone', summary: 'Create a zone', mutating: true }])])
    expect(latestPlan).toMatchObject({ decision: 'pending', canDecide: true, canExecute: false, executed: false })
    expect(latestPlan?.steps[0]).toMatchObject({ capability: 'createZone', status: 'pending' })
  })

  it('marks an approved, unexecuted plan as executable', () => {
    const { latestPlan } = buildTimeline([
      planTurn(1, [{ id: 's1', capability: 'createZone', summary: 'Create a zone', mutating: true }]),
      turn({ seq: 2, kind: 'approval', content: { plan_seq: 1 } }),
    ])
    expect(latestPlan).toMatchObject({ decision: 'approved', canDecide: false, canExecute: true })
  })

  it('reflects rejection with its reason and disables actions', () => {
    const { latestPlan } = buildTimeline([
      planTurn(1, [{ id: 's1', capability: 'createZone', summary: 'Create a zone', mutating: true }]),
      turn({ seq: 2, kind: 'rejection', content: { plan_seq: 1, reason: 'too broad' } }),
    ])
    expect(latestPlan).toMatchObject({ decision: 'rejected', rejectionReason: 'too broad', canDecide: false, canExecute: false })
  })

  it('folds execution turns into per-step status and marks the plan executed', () => {
    const { latestPlan } = buildTimeline([
      planTurn(1, [
        { id: 's1', capability: 'createZone', summary: 'Create a zone', mutating: true },
        { id: 's2', capability: 'registerApplication', summary: 'Register an app', mutating: true },
      ]),
      turn({ seq: 2, kind: 'approval', content: { plan_seq: 1 } }),
      turn({ seq: 3, kind: 'execution', role: 'operator', content: { plan_seq: 1, step_id: 's1', status: 'succeeded', detail: 'done' } }),
      turn({ seq: 4, kind: 'execution', role: 'operator', content: { plan_seq: 1, step_id: 's2', status: 'failed', detail: 'boom' } }),
    ])
    expect(latestPlan?.executed).toBe(true)
    expect(latestPlan?.canExecute).toBe(false)
    expect(latestPlan?.steps.find((s) => s.id === 's1')).toMatchObject({ status: 'succeeded', detail: 'done' })
    expect(latestPlan?.steps.find((s) => s.id === 's2')).toMatchObject({ status: 'failed', detail: 'boom' })
  })

  it('only treats the most recent plan as the actionable latest plan', () => {
    const { items, latestPlan } = buildTimeline([
      planTurn(1, [{ id: 's1', capability: 'createZone', summary: 'Create', mutating: true }]),
      turn({ seq: 2, kind: 'approval', content: { plan_seq: 1 } }),
      planTurn(3, [{ id: 's1', capability: 'registerApplication', summary: 'Register', mutating: true }]),
    ])
    expect(latestPlan?.seq).toBe(3)
    expect(latestPlan?.decision).toBe('pending')
    // The earlier plan is still rendered, resolved as approved, but is not the latest.
    const firstPlan = items.find((i) => i.kind === 'plan' && i.seq === 1)
    expect(firstPlan).toMatchObject({ decision: 'approved' })
  })

  it('returns no latest plan for a conversation without plans', () => {
    const { latestPlan } = buildTimeline([turn({ seq: 1, kind: 'message', content: { text: 'hi' } })])
    expect(latestPlan).toBeNull()
  })

  it('marks a plan approved by autopilot when the approval turn carries the autopilot flag', () => {
    const { latestPlan } = buildTimeline([
      planTurn(1, [{ id: 's1', capability: 'registerApplication', summary: 'Register', mutating: true }]),
      turn({ seq: 2, kind: 'approval', role: 'system', content: { plan_seq: 1, autopilot: true } }),
    ])
    expect(latestPlan?.decision).toBe('approved')
    expect(latestPlan?.approvedByAutopilot).toBe(true)
  })

  it('does not mark a human approval as autopilot', () => {
    const { latestPlan } = buildTimeline([
      planTurn(1, [{ id: 's1', capability: 'registerApplication', summary: 'Register', mutating: true }]),
      turn({ seq: 2, kind: 'approval', content: { plan_seq: 1 } }),
    ])
    expect(latestPlan?.decision).toBe('approved')
    expect(latestPlan?.approvedByAutopilot).toBe(false)
  })

  it('surfaces a persisted advisory security review on the plan', () => {
    const advisory = {
      summary: 'The grant is scoped to read; low blast-radius.',
      findings: [
        { severity: 'caution', concern: 'Confirm the resource selector is not wider than intended.' },
        { severity: 'info', concern: 'No write scopes are requested.' },
      ],
    }
    const { latestPlan } = buildTimeline([
      turn({
        seq: 1,
        kind: 'plan',
        role: 'operator',
        content: {
          summary: 'Grant Finance read-only Stripe',
          steps: [{ id: 's1', capability: 'grantAccess', summary: 'Grant', mutating: true }],
          advisory,
        },
      }),
    ])
    expect(latestPlan?.advisory?.summary).toBe(advisory.summary)
    expect(latestPlan?.advisory?.findings).toEqual(advisory.findings)
  })

  it('drops malformed advisory findings and omits an advisory with no summary', () => {
    const { items } = buildTimeline([
      turn({
        seq: 1,
        kind: 'plan',
        role: 'operator',
        content: {
          summary: 'Plan A',
          steps: [{ id: 's1', capability: 'createZone', summary: 'Create', mutating: true }],
          advisory: {
            summary: 'Reviewed.',
            findings: [
              { severity: 'bogus', concern: 'x' },
              { severity: 'warning', concern: '' },
              { severity: 'warning', concern: 'Real concern.' },
            ],
          },
        },
      }),
      turn({
        seq: 2,
        kind: 'plan',
        role: 'operator',
        content: {
          summary: 'Plan B',
          steps: [{ id: 's1', capability: 'createZone', summary: 'Create', mutating: true }],
          advisory: { summary: '', findings: [] },
        },
      }),
    ])
    const planA = items.find((i) => i.kind === 'plan' && i.seq === 1)
    const planB = items.find((i) => i.kind === 'plan' && i.seq === 2)
    // Only the well-formed finding survives; the unknown severity and the empty concern are dropped.
    expect(planA && planA.kind === 'plan' ? planA.advisory?.findings : null).toEqual([{ severity: 'warning', concern: 'Real concern.' }])
    // An advisory with no summary is treated as absent.
    expect(planB && planB.kind === 'plan' ? planB.advisory : 'missing').toBeUndefined()
  })

  it('surfaces the advisory alignment verdict and teaching recommendation', () => {
    const { latestPlan } = buildTimeline([
      turn({
        seq: 1,
        kind: 'plan',
        role: 'operator',
        content: {
          summary: 'Grant broad admin',
          steps: [{ id: 's1', capability: 'grantAccess', summary: 'Grant', mutating: true }],
          advisory: {
            summary: 'This grant is wider than the intent needs.',
            alignment: 'misaligned',
            findings: [],
            recommendation: 'Scope the grant to the single resource instead of the whole zone.',
          },
        },
      }),
    ])
    expect(latestPlan?.advisory?.alignment).toBe('misaligned')
    expect(latestPlan?.advisory?.recommendation).toBe('Scope the grant to the single resource instead of the whole zone.')
  })

  it('omits an unknown alignment and an empty recommendation', () => {
    const { latestPlan } = buildTimeline([
      turn({
        seq: 1,
        kind: 'plan',
        role: 'operator',
        content: {
          summary: 'Read state',
          steps: [{ id: 's1', capability: 'listZones', summary: 'List', mutating: false }],
          advisory: { summary: 'Read-only.', alignment: 'bogus', findings: [], recommendation: '' },
        },
      }),
    ])
    expect(latestPlan?.advisory?.alignment).toBeUndefined()
    expect(latestPlan?.advisory?.recommendation).toBeUndefined()
  })

  it('carries per-step dependencies and a recognized risk, dropping an unknown risk', () => {
    const { latestPlan } = buildTimeline([
      turn({
        seq: 1,
        kind: 'plan',
        role: 'operator',
        content: {
          summary: 'Connect then grant',
          steps: [
            { id: 's1', capability: 'connectProvider', summary: 'Connect', mutating: true, risk: 'high' },
            {
              id: 's2',
              capability: 'grantAccess',
              summary: 'Grant',
              mutating: true,
              depends_on: ['s1'],
              risk: 'bogus',
            },
          ],
        },
      }),
    ])
    expect(latestPlan?.steps[0]?.risk).toBe('high')
    expect(latestPlan?.steps[0]?.dependsOn).toEqual([])
    expect(latestPlan?.steps[1]?.dependsOn).toEqual(['s1'])
    expect(latestPlan?.steps[1]?.risk).toBeUndefined()
  })

  it('carries the previewed per-step effect, dropping an unknown effect', () => {
    const { latestPlan } = buildTimeline([
      turn({
        seq: 1,
        kind: 'plan',
        role: 'operator',
        content: {
          summary: 'Connect then grant',
          steps: [
            { id: 's1', capability: 'connectProvider', summary: 'Connect', mutating: true, effect: 'create' },
            { id: 's2', capability: 'grantAccess', summary: 'Grant', mutating: true, effect: 'exists' },
            { id: 's3', capability: 'listZones', summary: 'List', mutating: false, effect: 'bogus' },
          ],
        },
      }),
    ])
    expect(latestPlan?.steps[0]?.effect).toBe('create')
    expect(latestPlan?.steps[1]?.effect).toBe('exists')
    expect(latestPlan?.steps[2]?.effect).toBeUndefined()
  })

  it('records the deliberation trail on a plan and an answer, dropping unknown stages', () => {
    const { items, latestPlan } = buildTimeline([
      turn({
        seq: 1,
        kind: 'note',
        role: 'operator',
        content: { text: 'here is why', deliberation: ['triaging', 'gathering', 'answering'] },
      }),
      turn({
        seq: 2,
        kind: 'plan',
        role: 'operator',
        content: {
          summary: 'Stand up',
          steps: [{ id: 's1', capability: 'createZone', summary: 'Create a zone', mutating: true }],
          deliberation: ['triaging', 'planning', 'bogus', 'guarding'],
        },
      }),
    ])
    expect(items[0]).toMatchObject({ kind: 'note', deliberation: ['triaging', 'gathering', 'answering'] })
    expect(latestPlan?.deliberation).toEqual(['triaging', 'planning', 'guarding'])
  })

  it('omits an absent or non-array deliberation', () => {
    const { items, latestPlan } = buildTimeline([
      turn({ seq: 1, kind: 'note', role: 'operator', content: { text: 'no trail' } }),
      turn({
        seq: 2,
        kind: 'plan',
        role: 'operator',
        content: {
          summary: 'Stand up',
          steps: [{ id: 's1', capability: 'createZone', summary: 'Create a zone', mutating: true }],
          deliberation: 'not-an-array',
        },
      }),
    ])
    expect(items[0]).not.toHaveProperty('deliberation')
    expect(latestPlan?.deliberation).toBeUndefined()
  })

  it('parses a full policy draft onto the operator note that carried it', () => {
    const draft = {
      summary: 'Grant PiperNet operators read access.',
      intent: 'Least-privilege read for the operator role on PiperNet.',
      documents: [
        {
          concern: 'PiperNet read grants',
          filename: 'pipernet-read.rego',
          content: '# caracal:data-document\npackage caracal.authz\n\ngrants := {}\n',
          explanation: 'Supplies the grant data the platform contract reads.',
          preview: {
            package: 'caracal.authz',
            rules: ['grants'],
            default_result: true,
            decisions: ['allow'],
            inputs_referenced: ['input.subject'],
            data_referenced: ['data.grants'],
          },
        },
      ],
      clarifications: [],
      assumptions: ['The operator role already exists.'],
      risks: [
        { severity: 'caution', note: 'Confirm the resource selector is not wider than intended.' },
        { severity: 'nonsense', note: 'Falls back to info severity.' },
      ],
      recommendations: ['Scope grants to the single resource.'],
      simulations: [
        {
          name: 'operator reads',
          description: 'An operator reads PiperNet.',
          input: { subject: { role: 'operator' } },
          expectedDecision: 'allow',
        },
      ],
      activation: { ready: false, blockers: ['No policy set yet.'], guidance: 'Compose into a set first.' },
      schemaVersion: '2026-01',
      provenance: {
        aiAssisted: true,
        model: 'son-of-anton',
        generatedAt: '2026-01-01T00:00:00Z',
        sourceMessage: 'grant operators read on pipernet',
      },
    }
    const { items } = buildTimeline([
      turn({ seq: 1, kind: 'note', role: 'operator', content: { text: 'Here is a draft.', policy: draft } }),
    ])
    const note = items[0]
    expect(note.kind).toBe('note')
    if (note.kind !== 'note' || !note.policy) throw new Error('expected a policy on the note')
    expect(note.policy.summary).toBe(draft.summary)
    expect(note.policy.documents).toHaveLength(1)
    expect(note.policy.documents[0]).toMatchObject({
      concern: 'PiperNet read grants',
      filename: 'pipernet-read.rego',
    })
    expect(note.policy.documents[0]?.preview).toMatchObject({
      package: 'caracal.authz',
      rules: ['grants'],
      defaultResult: true,
      decisions: ['allow'],
      inputsReferenced: ['input.subject'],
      dataReferenced: ['data.grants'],
    })
    // An unrecognized risk severity degrades to info rather than dropping the risk.
    expect(note.policy.risks).toEqual([
      { severity: 'caution', note: 'Confirm the resource selector is not wider than intended.' },
      { severity: 'info', note: 'Falls back to info severity.' },
    ])
    expect(note.policy.simulations[0]).toMatchObject({ name: 'operator reads', expectedDecision: 'allow' })
    expect(note.policy.activation).toMatchObject({ ready: false, blockers: ['No policy set yet.'] })
    expect(note.policy.provenance).toMatchObject({ aiAssisted: true, model: 'son-of-anton' })
  })

  it('parses a clarification-only policy draft with no documents', () => {
    const draft = {
      summary: 'Need more detail before authoring.',
      intent: '',
      documents: [],
      clarifications: ['Which resource should this cover?', 'Read only, or read and write?'],
      assumptions: [],
      risks: [],
      recommendations: [],
      simulations: [],
      activation: null,
      schemaVersion: '2026-01',
      provenance: { aiAssisted: true, model: 'fiona', generatedAt: '2026-01-01T00:00:00Z', sourceMessage: 'grant access' },
    }
    const { items } = buildTimeline([
      turn({ seq: 1, kind: 'note', role: 'operator', content: { text: 'I need a bit more.', policy: draft } }),
    ])
    const note = items[0]
    if (note.kind !== 'note' || !note.policy) throw new Error('expected a policy on the note')
    expect(note.policy.documents).toHaveLength(0)
    expect(note.policy.clarifications).toEqual(['Which resource should this cover?', 'Read only, or read and write?'])
    expect(note.policy.activation).toBeNull()
  })

  it('omits a policy with no summary and a document with no content', () => {
    const { items } = buildTimeline([
      turn({ seq: 1, kind: 'note', role: 'operator', content: { text: 'plain note', policy: { summary: '' } } }),
      turn({
        seq: 2,
        kind: 'note',
        role: 'operator',
        content: {
          text: 'a draft',
          policy: {
            summary: 'Has one valid doc.',
            documents: [
              { concern: 'empty', filename: 'x.rego', content: '', explanation: 'dropped', preview: null },
              { concern: 'kept', filename: 'y.rego', content: 'package caracal.authz\n', explanation: 'kept', preview: null },
            ],
          },
        },
      }),
    ])
    const plain = items[0]
    const drafted = items[1]
    if (plain.kind !== 'note' || drafted.kind !== 'note') throw new Error('expected note items')
    // A draft with no summary is treated as absent, leaving the note as plain prose.
    expect(plain).not.toHaveProperty('policy')
    // A document with no content is dropped; only the one carrying Rego survives.
    expect(drafted.policy?.documents).toHaveLength(1)
    expect(drafted.policy?.documents[0]).toMatchObject({ concern: 'kept', filename: 'y.rego' })
  })

  it('surfaces structured evidence on a note, keeping only sound entries and cells', () => {
    const { items } = buildTimeline([
      turn({
        seq: 1,
        kind: 'note',
        role: 'operator',
        content: {
          text: 'you have one application',
          evidence: [
            {
              capability: 'listApplications',
              domain: 'application',
              count: 1,
              rows: [{ id: 'app-1', name: 'Son of Anton', scopes: ['read', 7, 'write'], config: { nested: true } }],
            },
            { capability: 'listResources', domain: 'resource', rows: [{ id: 'res-1', name: 'PiperNet' }] },
            { domain: 'provider', count: 3 },
            'not an entry',
          ],
        },
      }),
    ])
    const note = items[0]
    if (note.kind !== 'note') throw new Error('expected a note item')
    // The entry without a capability and the non-object entry are dropped; the rest survive.
    expect(note.evidence).toHaveLength(2)
    // Row cells keep strings and string lists; the number inside the list and the object are dropped.
    expect(note.evidence?.[0]).toMatchObject({
      capability: 'listApplications',
      domain: 'application',
      count: 1,
      rows: [{ id: 'app-1', name: 'Son of Anton', scopes: ['read', 'write'] }],
    })
    expect(note.evidence?.[0]?.rows[0]).not.toHaveProperty('config')
    // A missing count falls back to the number of rows that survived.
    expect(note.evidence?.[1]).toMatchObject({ capability: 'listResources', domain: 'resource', count: 1 })
  })

  it('omits evidence when it is absent, not a list, or entirely malformed', () => {
    const { items } = buildTimeline([
      turn({ seq: 1, kind: 'note', role: 'operator', content: { text: 'plain prose' } }),
      turn({ seq: 2, kind: 'note', role: 'operator', content: { text: 'bad shape', evidence: { capability: 'listApplications' } } }),
      turn({ seq: 3, kind: 'note', role: 'operator', content: { text: 'empty entries', evidence: [{ rows: [] }, 42] } }),
    ])
    for (const item of items) {
      expect(item).not.toHaveProperty('evidence')
    }
  })
})
