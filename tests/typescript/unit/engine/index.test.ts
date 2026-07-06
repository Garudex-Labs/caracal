// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Engine package index tests verify the public export surface remains reachable.

import { describe, expect, it } from 'vitest'
import * as engine from '../../../../packages/engine/src/index.js'

describe('@caracalai/engine index', () => {
  it('exports the shared runtime, dispatch, control, and stack helpers', () => {
    expect(engine.buildAdminClient).toEqual(expect.any(Function))
    expect(engine.dispatch).toEqual(expect.any(Function))
    expect(engine.controlScopes).toEqual(expect.any(Function))
    expect(engine.stackStatus).toEqual(expect.any(Function))
    expect(engine.formatVersionOutput).toEqual(expect.any(Function))
  })
})
