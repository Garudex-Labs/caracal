// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies the dispatcher implements a handler for every engine-routed catalog subcommand, so a declared-but-unhandled subcommand fails the build instead of failing at dispatch time.

import { describe, it, expect } from 'vitest'
import { MANAGEMENT_COMMANDS } from '../../../../packages/engine/src/commands.js'
import { LOCAL_ONLY_COMMANDS, LOCAL_ONLY_SUBCOMMANDS, engineHandlerCoverage } from '../../../../packages/engine/src/dispatch.js'

describe('dispatch handler parity', () => {
  it('routes every declared subcommand of every engine-routed command', () => {
    for (const desc of MANAGEMENT_COMMANDS) {
      const coverage = engineHandlerCoverage(desc.name)
      if (coverage === 'local-only' || coverage === 'all') continue
      const exempt = LOCAL_ONLY_SUBCOMMANDS[desc.name] ?? []
      for (const sub of desc.subcommands ?? []) {
        if (exempt.includes(sub)) continue
        expect(coverage, `${desc.name} "${sub}" is declared but has no dispatcher arm`).toContain(sub)
      }
    }
  })

  it('treats every unrouted command as an explicit local-only exception', () => {
    for (const desc of MANAGEMENT_COMMANDS) {
      if (engineHandlerCoverage(desc.name) !== 'local-only') continue
      expect(LOCAL_ONLY_COMMANDS, `${desc.name} has no dispatcher arm and is not allowlisted as local-only`).toContain(desc.name)
    }
  })

  it('keeps the local-only command allowlist free of stale entries', () => {
    for (const name of LOCAL_ONLY_COMMANDS) {
      const desc = MANAGEMENT_COMMANDS.find((c) => c.name === name)
      expect(desc, `local-only command "${name}" is no longer in the catalog`).toBeDefined()
      expect(engineHandlerCoverage(name), `local-only command "${name}" now has a handler; remove it from the allowlist`).toBe('local-only')
    }
  })

  it('keeps the local-only subcommand allowlist free of stale entries', () => {
    for (const [command, subs] of Object.entries(LOCAL_ONLY_SUBCOMMANDS)) {
      const desc = MANAGEMENT_COMMANDS.find((c) => c.name === command)
      expect(desc, `local-only command "${command}" is no longer in the catalog`).toBeDefined()
      const coverage = engineHandlerCoverage(command)
      for (const sub of subs) {
        expect(desc?.subcommands ?? [], `${command} "${sub}" is no longer a declared subcommand`).toContain(sub)
        if (Array.isArray(coverage)) {
          expect(coverage, `${command} "${sub}" now has a dispatcher arm; remove it from the allowlist`).not.toContain(sub)
        }
      }
    }
  })
})
