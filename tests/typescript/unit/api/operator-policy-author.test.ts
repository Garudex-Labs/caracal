// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator policy specialist: grounded authoring, deterministic validation, repair, and provenance.

import { describe, it, expect, vi } from 'vitest'
import { runPolicyAuthor, buildPolicyAuthorMessages, type AgentContext } from '../../../../apps/api/src/operator-agents.js'
import { OPA_INPUT_SCHEMA_VERSION } from '../../../../apps/api/src/rego.js'
import type { Gateway, CompletionObjectResult } from '../../../../apps/api/src/operator-gateway.js'

// A valid Caracal data document: the directive line, package caracal.authz, and one data rule that
// is not `result`, so validateAuthzPolicy accepts it and previewAuthzPolicy can read it.
const VALID_DOC = [
  '# caracal:data-document',
  'package caracal.authz',
  '',
  'import rego.v1',
  '',
  'app_ids := {"reporting": "app_reporting_01"}',
  '',
  'grants := {"resource://nucleus": {"application": "reporting", "roles": {"reader": ["nucleus:read"]}}}',
].join('\n')

// A document that defines `result`, which the platform contract owns; validateAuthzPolicy rejects it
// with data_document_must_not_define_result.
const RESULT_DOC = ['# caracal:data-document', 'package caracal.authz', '', 'result := {"decision": "allow"}'].join('\n')

// A document missing the data-document directive; validateAuthzPolicy rejects it with must_be_data_document.
const NO_DIRECTIVE_DOC = ['package caracal.authz', '', 'app_ids := {"reporting": "app_reporting_01"}'].join('\n')

function validOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: 'Grant the reporting app read on Nucleus.',
    intent: 'Give the reporting application read-only access to Nucleus.',
    documents: [
      {
        concern: 'reporting read grant on Nucleus',
        filename: 'grants.rego',
        content: VALID_DOC,
        explanation: 'Binds the reporting application to a reader role that may request nucleus:read.',
      },
    ],
    ...overrides,
  }
}

// A gateway stub whose structured completions are scripted in order: a value resolves as the
// schema-validated object with a fixed serving model, and an Error rejects as the SDK would on an
// off-schema answer, so the specialist's validation and repair loop are exercised against both.
function gatewayProducing(...results: (object | Error)[]): { gateway: Gateway; completeObject: ReturnType<typeof vi.fn> } {
  const completeObject = vi.fn()
  for (const result of results) {
    if (result instanceof Error) {
      completeObject.mockRejectedValueOnce(result)
    } else {
      completeObject.mockResolvedValueOnce({ value: result, provider: 'test', model: 'm' } satisfies CompletionObjectResult<object>)
    }
  }
  return {
    gateway: { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway,
    completeObject,
  }
}

const context: AgentContext = { facts: null, state: null }

describe('runPolicyAuthor', () => {
  it('returns a validated draft with a per-document preview, provenance, and schema version', async () => {
    const { gateway, completeObject } = gatewayProducing(validOutput())
    const result = await runPolicyAuthor(gateway, 'give the reporting app read on nucleus', context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(completeObject).toHaveBeenCalledTimes(1)
    expect(result.value.documents).toHaveLength(1)
    const doc = result.value.documents[0]
    expect(doc.content).toBe(VALID_DOC)
    // The preview is Caracal's own reading of the content, so it reports the data rules and the input
    // and data paths the document references - never the model's claim.
    expect(doc.preview?.package).toBe('caracal.authz')
    expect(doc.preview?.rules).toContain('grants')
    expect(result.value.schemaVersion).toBe(OPA_INPUT_SCHEMA_VERSION)
    expect(result.value.provenance).toMatchObject({ aiAssisted: true, model: 'm' })
    expect(result.value.provenance.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.value.clarifications).toEqual([])
  })

  it('carries the operator request into provenance so the draft is traceable', async () => {
    const { gateway } = gatewayProducing(validOutput())
    const result = await runPolicyAuthor(gateway, '  give   the reporting app read  ', context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.provenance.sourceMessage).toBe('give the reporting app read')
  })

  it('maps the metadata arrays and simulation cases onto the draft', async () => {
    const { gateway } = gatewayProducing(
      validOutput({
        assumptions: ['reporting is the app named reporting'],
        risks: [{ severity: 'caution', note: 'nucleus:read exposes report data' }],
        recommendations: ['confine reporting to nucleus:read only'],
        simulations: [
          { name: 'reader allowed', description: 'reporting reads nucleus', input: { action: 'read' }, expected_decision: 'allow' },
          { name: 'writer denied', description: 'reporting writes nucleus', input: { action: 'write' }, expected_decision: 'deny' },
        ],
        activation: { ready: false, blockers: ['activate the policy set'], guidance: 'Create a version, then activate it.' },
      }),
    )
    const result = await runPolicyAuthor(gateway, 'give reporting read', context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.assumptions).toEqual(['reporting is the app named reporting'])
    expect(result.value.risks).toEqual([{ severity: 'caution', note: 'nucleus:read exposes report data' }])
    expect(result.value.recommendations).toEqual(['confine reporting to nucleus:read only'])
    expect(result.value.simulations).toEqual([
      { name: 'reader allowed', description: 'reporting reads nucleus', input: { action: 'read' }, expectedDecision: 'allow' },
      { name: 'writer denied', description: 'reporting writes nucleus', input: { action: 'write' }, expectedDecision: 'deny' },
    ])
    expect(result.value.activation).toEqual({ ready: false, blockers: ['activate the policy set'], guidance: 'Create a version, then activate it.' })
  })

  it('relays clarifying questions as a valid outcome when no document is authored', async () => {
    const { gateway, completeObject } = gatewayProducing({
      summary: 'Need the application before authoring the grant.',
      intent: 'Grant some application read on a resource.',
      documents: [],
      clarifications: ['Which application should receive the grant?'],
    })
    const result = await runPolicyAuthor(gateway, 'grant read access', context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(completeObject).toHaveBeenCalledTimes(1)
    expect(result.value.documents).toEqual([])
    expect(result.value.clarifications).toEqual(['Which application should receive the grant?'])
    // A clarification-only draft is still AI-assisted and provenance-stamped.
    expect(result.value.provenance.aiAssisted).toBe(true)
  })

  it('fails closed when the model returns neither a document nor a question', async () => {
    const { gateway } = gatewayProducing({ summary: 's', intent: 'i', documents: [] })
    const result = await runPolicyAuthor(gateway, 'author a policy', context)
    expect(result).toEqual({ ok: false, error: 'policy author produced neither a document nor a clarifying question' })
  })

  it('repairs a rejected document by feeding the exact reason back, then returns the corrected draft', async () => {
    const { gateway, completeObject } = gatewayProducing(
      validOutput({ documents: [{ concern: 'grant', filename: 'grants.rego', content: RESULT_DOC, explanation: 'x' }] }),
      validOutput(),
    )
    const result = await runPolicyAuthor(gateway, 'give reporting read', context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(completeObject).toHaveBeenCalledTimes(2)
    // The second call carries the precise rejection reason so the model fixes the exact problem.
    const repairMessages = completeObject.mock.calls[1][0] as { role: string; content: string }[]
    const userTurn = repairMessages[repairMessages.length - 1].content
    expect(userTurn).toContain('Caracal rejected')
    expect(userTurn).toContain('must never define "result"')
    expect(result.value.documents[0].content).toBe(VALID_DOC)
  })

  it('fails closed after exhausting repairs when the model never produces a valid document', async () => {
    const bad = validOutput({ documents: [{ concern: 'grant', filename: 'grants.rego', content: NO_DIRECTIVE_DOC, explanation: 'x' }] })
    const { gateway, completeObject } = gatewayProducing(bad, bad, bad)
    const result = await runPolicyAuthor(gateway, 'give reporting read', context)
    expect(result).toEqual({ ok: false, error: 'policy author could not produce data documents that pass validation' })
    // One initial attempt plus two bounded repair passes: never an unbounded loop.
    expect(completeObject).toHaveBeenCalledTimes(3)
  })

  it('never surfaces a document the platform contract would reject: a result-defining document is dropped from the draft', async () => {
    const { gateway } = gatewayProducing(
      validOutput({
        documents: [
          { concern: 'good', filename: 'grants.rego', content: VALID_DOC, explanation: 'ok' },
          { concern: 'bad', filename: 'result.rego', content: RESULT_DOC, explanation: 'no' },
        ],
      }),
      validOutput(),
    )
    const result = await runPolicyAuthor(gateway, 'give reporting read', context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The mixed draft was rejected wholesale and repaired; the surfaced draft contains only valid documents.
    for (const doc of result.value.documents) expect(doc.preview?.rules).not.toContain('result')
  })

  it('fails closed on an off-schema completion rather than emitting a guessed draft', async () => {
    const { gateway } = gatewayProducing(new Error('schema mismatch'))
    const result = await runPolicyAuthor(gateway, 'author a policy', context)
    expect(result).toEqual({ ok: false, error: 'policy author returned a draft that failed the schema' })
  })
})

describe('buildPolicyAuthorMessages', () => {
  it('builds a system and user turn without repair feedback on the first pass', () => {
    const messages = buildPolicyAuthorMessages('give reporting read', context)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('YOUR JOB: AUTHOR POLICY')
    expect(messages[0].content).toContain('THE ONLY SUPPORTED DATA RULES')
    expect(messages[messages.length - 1].role).toBe('user')
    expect(messages[messages.length - 1].content).toContain('Request: give reporting read')
    expect(messages[messages.length - 1].content).not.toContain('Caracal rejected')
  })

  it('folds repair diagnostics into the user turn when a prior draft was rejected', () => {
    const messages = buildPolicyAuthorMessages('give reporting read', context, {
      priorSummary: 'a grant',
      diagnostics: ['grants.rego (grant): the document must declare "package caracal.authz"'],
    })
    const userTurn = messages[messages.length - 1].content
    expect(userTurn).toContain('Caracal rejected')
    expect(userTurn).toContain('the document must declare "package caracal.authz"')
  })
})
