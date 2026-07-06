// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies the dispatcher implements a handler for every engine-routed catalog subcommand, so a declared-but-unhandled subcommand fails the build instead of failing at dispatch time.

import { describe, it, expect } from 'vitest'
import { MANAGEMENT_COMMANDS } from '../../../../packages/engine/src/commands.js'
import { engineHandlerCoverage } from '../../../../packages/engine/src/dispatch.js'

describe('dispatch handler parity', () => {
  it('routes every declared subcommand of every catalog command', () => {
    for (const desc of MANAGEMENT_COMMANDS) {
      const coverage = engineHandlerCoverage(desc.name)
      expect(coverage, `${desc.name} has no dispatcher arm`).toBeDefined()
      if (coverage === 'all') continue
      for (const sub of desc.subcommands ?? []) {
        expect(coverage, `${desc.name} "${sub}" is declared but has no dispatcher arm`).toContain(sub)
      }
    }
  })
})
