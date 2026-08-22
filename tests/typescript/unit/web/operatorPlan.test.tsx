/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file verifies the Operator plan card dispatches credential-recovery execution exactly once.
*/
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PlanItem } from '@/platform/operator/timeline'

const state = vi.hoisted(() => ({
  secretsProvided: false,
  executePlan: vi.fn(),
  provideSecrets: vi.fn(),
}))

vi.mock('@/platform/api/hooks', () => ({
  useDecideOperatorPlan: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useExecuteOperatorPlan: () => ({
    mutate: state.executePlan,
    isPending: false,
    isError: false,
    error: null,
    data: undefined,
  }),
  useOperatorCapabilities: () => ({ data: [] }),
  useOperatorPlanSecrets: () => ({
    data: {
      plan_seq: 7,
      steps: [
        {
          step_id: 'provider-step',
          fields: ['client_id', 'client_secret'],
          provided: state.secretsProvided,
        },
      ],
    },
    isError: false,
  }),
  useProvidePlanSecrets: () => ({
    mutate: state.provideSecrets,
    isPending: false,
    isError: false,
  }),
}))

vi.mock('@/components/console/SecretCredentialDialog', () => ({
  SecretCredentialDialog: ({ onSubmit }: { onSubmit: (values: Record<string, string>) => void }) => (
    <button type="button" onClick={() => onSubmit({ client_id: 'client', client_secret: 'secret' })}>
      Submit replacement credentials
    </button>
  ),
}))

const { PlanArtifact } = await import('@/components/console/OperatorPlan')

const plan: PlanItem = {
  kind: 'plan',
  id: 'plan-7',
  seq: 7,
  summary: 'Connect Hooli OIDC',
  steps: [
    {
      id: 'provider-step',
      capability: 'connectProvider',
      summary: 'Connect provider',
      mutating: true,
      args: { name: 'Hooli OIDC', kind: 'oauth2_client_credentials' },
      status: 'pending',
      dependsOn: [],
      effect: 'create',
      secretFields: ['client_id', 'client_secret'],
    },
  ],
  decision: 'approved',
  rejectionReason: null,
  executed: false,
  canDecide: false,
  canExecute: true,
  approvedByAutopilot: false,
}

afterEach(() => {
  cleanup()
  state.secretsProvided = false
  state.executePlan.mockReset()
  state.provideSecrets.mockReset()
})

describe('PlanArtifact credential recovery', () => {
  it('does not dispatch twice when refreshed vault status resolves during recovery execution', async () => {
    state.provideSecrets.mockImplementation((_input: unknown, options: { onSuccess: (result: { all_satisfied: boolean }) => void }) => {
      options.onSuccess({ all_satisfied: true })
    })

    const view = render(<PlanArtifact plan={plan} zoneId="z1" conversationId="conv-1" />)
    const submit = await screen.findByRole('button', { name: 'Submit replacement credentials' })
    fireEvent.click(submit)

    expect(state.executePlan).toHaveBeenCalledTimes(1)
    expect(state.executePlan).toHaveBeenCalledWith(7)

    // The credential mutation invalidates this status query. Model that refresh completing while
    // the explicit execute mutation is still in flight; the automatic effect must observe that
    // this plan sequence was already dispatched.
    state.secretsProvided = true
    view.rerender(<PlanArtifact plan={plan} zoneId="z1" conversationId="conv-1" />)

    await waitFor(() => expect(state.executePlan).toHaveBeenCalledTimes(1))
  })
})
