// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator status vocabulary: exact plan lifecycle labels and the seeded, rotating working and applying indicators.

import { describe, it, expect } from 'vitest'
import { PLAN_STATUS, applyingLine, workingLine } from '../../../../apps/web/src/platform/operator/status'

describe('PLAN_STATUS', () => {
  it('pins one authoritative wording for each lifecycle state', () => {
    expect(PLAN_STATUS).toEqual({
      awaitingApproval: 'Awaiting approval',
      approved: 'Approved',
      approvedByAutopilot: 'Approved by autopilot',
      applied: 'Applied',
      rejected: 'Rejected',
    })
  })
})

describe('workingLine', () => {
  it('holds one line steady for a given seed', () => {
    expect(workingLine(3)).toBe(workingLine(3))
  })
  it('rotates to a different line as the seed advances', () => {
    expect(workingLine(0)).not.toBe(workingLine(1))
  })
  it('cycles back to the start once the seed wraps the catalog', () => {
    expect(workingLine(0)).toBe(workingLine(7))
  })
  it('wraps a negative seed onto a real line', () => {
    expect(workingLine(-1)).toBe(workingLine(6))
  })
  it('lands on a real entry for a large seed', () => {
    expect(typeof workingLine(10_000)).toBe('string')
    expect(workingLine(10_000).length).toBeGreaterThan(0)
  })
})

describe('applyingLine', () => {
  it('holds one line steady for a given seed', () => {
    expect(applyingLine(2)).toBe(applyingLine(2))
  })
  it('rotates to a different line as the seed advances', () => {
    expect(applyingLine(0)).not.toBe(applyingLine(1))
  })
  it('cycles back to the start once the seed wraps the catalog', () => {
    expect(applyingLine(0)).toBe(applyingLine(5))
  })
  it('wraps a negative seed onto a real line', () => {
    expect(applyingLine(-1)).toBe(applyingLine(4))
  })
})
