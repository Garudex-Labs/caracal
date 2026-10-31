// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for governed agent launch profile parsing and validation.

import { describe, expect, it } from 'vitest'
import { parseAgentProfile } from '../../../../packages/engine/src/agentProfile.js'

const valid = {
  model: { resource: 'resource://pipernet-models', scopes: ['models:invoke'] },
  tools: { resource: 'resource://claude-code-tools', scopes: ['tool:Read', 'tool:Bash', 'tool:mcp__pipernet__search'] },
}

function parse(body: unknown) {
  return parseAgentProfile('anton.json', JSON.stringify(body))
}

describe('parseAgentProfile', () => {
  it('accepts model and tools grants with optional labels', () => {
    expect(parse(valid)).toEqual(valid)
    expect(parse({ ...valid, labels: ['payout-review'] }).labels).toEqual(['payout-review'])
  })

  it('rejects malformed JSON and non-object profiles', () => {
    expect(() => parseAgentProfile('anton.json', '{')).toThrow(/valid JSON/)
    expect(() => parse([valid])).toThrow(/JSON object/)
  })

  it('rejects unknown keys so typos cannot silently drop a grant', () => {
    expect(() => parse({ ...valid, tool: valid.tools })).toThrow(/unsupported keys: tool/)
    expect(() => parse({ ...valid, model: { ...valid.model, scope: 'models:invoke' } })).toThrow(/model has unsupported keys: scope/)
  })

  it('requires both grants with at least one scope', () => {
    expect(() => parse({ tools: valid.tools })).toThrow(/model must be an object/)
    expect(() => parse({ ...valid, tools: { resource: valid.tools.resource, scopes: [] } })).toThrow(
      /tools.scopes must be a non-empty array/,
    )
  })

  it('rejects values that would split on the wire', () => {
    expect(() => parse({ ...valid, tools: { ...valid.tools, scopes: ['tool:Read tool:Bash'] } })).toThrow(/tools.scopes\[0\]/)
    expect(() => parse({ ...valid, model: { ...valid.model, resource: '' } })).toThrow(/model.resource/)
  })

  it('requires distinct model and tools Resources', () => {
    expect(() => parse({ ...valid, tools: { ...valid.tools, resource: valid.model.resource } })).toThrow(/different Resources/)
  })
})
