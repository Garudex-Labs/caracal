// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the runtime command registry: it must reject wiring drift between descriptors and executors.

import { describe, it, expect } from 'vitest'
import { buildRegistry, type Executor } from '../../../../apps/cli/src/registry.ts'
import { SHELL_COMMANDS, CLI_COMMANDS } from '../../../../packages/engine/src/commands.ts'

const noop: Executor = () => undefined

describe('buildRegistry', () => {
  it('binds every descriptor to its executor and preserves order', () => {
    const executors = Object.fromEntries(SHELL_COMMANDS.map((c) => [c.name, noop]))
    const reg = buildRegistry(SHELL_COMMANDS, executors)
    expect(reg.ordered.map((b) => b.descriptor.name)).toEqual(SHELL_COMMANDS.map((c) => c.name))
    for (const c of SHELL_COMMANDS) expect(reg.byName.has(c.name)).toBe(true)
  })

  it('throws when a descriptor has no executor', () => {
    const executors: Record<string, Executor> = { up: noop, down: noop, status: noop, purge: noop, cli: noop }
    expect(() => buildRegistry(SHELL_COMMANDS, executors)).toThrow(/missing executors/)
  })

  it('throws when an executor has no descriptor', () => {
    const executors = Object.fromEntries(SHELL_COMMANDS.map((c) => [c.name, noop]))
    executors['rogue'] = noop
    expect(() => buildRegistry(SHELL_COMMANDS, executors)).toThrow(/no descriptor/)
  })

  it('requires CLI_COMMANDS to be fully wireable', () => {
    const executors = Object.fromEntries(CLI_COMMANDS.map((c) => [c.name, noop]))
    expect(() => buildRegistry(CLI_COMMANDS, executors)).not.toThrow()
  })
})
