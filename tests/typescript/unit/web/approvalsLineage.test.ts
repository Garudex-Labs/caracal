/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for the approval hold session lineage read from challenge metadata.
*/
import { describe, expect, it } from 'vitest'

import { sessionLineage } from '../../../../apps/web/src/lib/approvalMetadata'
import type { StepUpChallenge } from '../../../../apps/web/src/platform/api/types'

function challenge(meta: Record<string, unknown> | null): StepUpChallenge {
  return { metadata_json: meta } as unknown as StepUpChallenge
}

describe('sessionLineage', () => {
  it('reads the requesting session and delegation edge from challenge metadata', () => {
    const lineage = sessionLineage(challenge({ agent_session_id: 'agent-123', delegation_edge_id: 'edge-9' }))
    expect(lineage.session).toBe('agent-123')
    expect(lineage.edge).toBe('edge-9')
  })

  it('does not mistake a metadata id field for the requesting session', () => {
    const lineage = sessionLineage(challenge({ id: 'challenge-meta-id' }))
    expect(lineage.session).toBeUndefined()
  })

  it('returns nothing when the challenge carried no metadata', () => {
    expect(sessionLineage(challenge(null))).toEqual({})
  })
})
