// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the completion script generator: covers both binaries, every shell, and rejects bad input.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { completionCommand } from '../../../../apps/cli/src/commands/completion.ts'
import { CLI_COMMANDS, SHELL_COMMANDS } from '../../../../packages/engine/src/commands.ts'

function capture(): { out: () => string; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { chunks.push(String(c)); return true }) as never)
  return { out: () => chunks.join(''), restore: () => spy.mockRestore() }
}

afterEach(() => { vi.restoreAllMocks() })

describe('completionCommand', () => {
  it('rejects an unknown shell', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as never)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(() => completionCommand(['ksh'])).toThrow('exit:1')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('rejects an unknown target binary', () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as never)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(() => completionCommand(['bash', 'caracal-rogue'])).toThrow('exit:1')
  })

  for (const shell of ['bash', 'zsh', 'fish', 'powershell'] as const) {
    it(`emits caracal-cli completion for ${shell} listing every CLI command`, () => {
      const cap = capture()
      completionCommand([shell, 'caracal-cli'])
      const out = cap.out()
      for (const c of CLI_COMMANDS) expect(out).toContain(c.name)
      expect(out).toContain('caracal-cli')
    })

    it(`emits caracal (shell) completion for ${shell} listing every shell command`, () => {
      const cap = capture()
      completionCommand([shell, 'caracal'])
      const out = cap.out()
      for (const c of SHELL_COMMANDS) expect(out).toContain(c.name)
    })
  }

  it('defaults to both binaries when no target is provided', () => {
    const cap = capture()
    completionCommand(['bash'])
    const out = cap.out()
    expect(out).toContain('complete -F _caracal ')
    expect(out).toContain('complete -F _caracal_cli ')
  })

  it('includes completion itself in the CLI command list', () => {
    const cap = capture()
    completionCommand(['bash', 'caracal-cli'])
    expect(cap.out()).toMatch(/\bcompletion\b/)
  })

  it('keeps Control management off the thin shell command list', () => {
    expect(SHELL_COMMANDS.some((c) => c.name === 'control')).toBe(false)
    expect(CLI_COMMANDS.some((c) => c.name === 'control')).toBe(true)
  })
})
