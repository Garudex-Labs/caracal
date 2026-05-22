// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the shared dispatcher kernel: whitelist enforcement, usage rendering, version handling.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { dispatch } from '../../../../apps/cli/src/dispatcher.ts'
import { buildRegistry, type Executor } from '../../../../apps/cli/src/registry.ts'
import { CLI_COMMANDS, SHELL_COMMANDS } from '../../../../packages/engine/src/commands.ts'

function makeOpts(run: Executor) {
  const executors = Object.fromEntries(SHELL_COMMANDS.map((c) => [c.name, run]))
  const registry = buildRegistry(SHELL_COMMANDS, executors)
  return { binary: 'caracal', version: '0.0.0', mode: 'dev' as const, registry }
}

const exitSpy = () => vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as never)

afterEach(() => { vi.restoreAllMocks() })

describe('dispatch', () => {
  it('routes a valid command to its executor', async () => {
    const run = vi.fn() as Executor
    await dispatch(makeOpts(run), ['status'])
    expect(run).toHaveBeenCalledOnce()
  })

  it('passes remaining argv to the executor', async () => {
    const run = vi.fn() as Executor
    await dispatch(makeOpts(run), ['up', '--detach'])
    expect(run).toHaveBeenCalledWith(['--detach'], undefined)
  })

  it('strips a leading -- separator', async () => {
    const run = vi.fn() as Executor
    await dispatch(makeOpts(run), ['--', 'status'])
    expect(run).toHaveBeenCalledOnce()
  })

  it('rejects unknown commands with exit 1', async () => {
    const exit = exitSpy()
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await expect(dispatch(makeOpts(vi.fn() as Executor), ['bogus'])).rejects.toThrow('exit:1')
    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr).toHaveBeenCalled()
  })

  it('rejects malformed command names', async () => {
    const exit = exitSpy()
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await expect(dispatch(makeOpts(vi.fn() as Executor), ['Bad-Name'])).rejects.toThrow('exit:1')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('prints usage on --help and exits 0', async () => {
    const exit = exitSpy()
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await expect(dispatch(makeOpts(vi.fn() as Executor), ['--help'])).rejects.toThrow('exit:0')
    expect(exit).toHaveBeenCalledWith(0)
    const out = stdout.mock.calls.map((c) => String(c[0])).join('')
    for (const c of SHELL_COMMANDS) expect(out).toContain(c.name)
    expect(out).not.toContain('NO_COLOR')
    expect(out).not.toContain('FORCE_COLOR')
  })

  it('prints version on --version', async () => {
    exitSpy()
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await expect(dispatch(makeOpts(vi.fn() as Executor), ['--version'])).rejects.toThrow('exit:0')
    const out = stdout.mock.calls.map((c) => String(c[0])).join('')
    expect(out).toContain('Caracal')
    expect(out).toContain('binary   caracal')
    expect(out).toContain('version  0.0.0')
    expect(out).toContain('mode     dev')
  })

  it('treats empty argv as help', async () => {
    const exit = exitSpy()
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await expect(dispatch(makeOpts(vi.fn() as Executor), [])).rejects.toThrow('exit:0')
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('renders Usage line using the configured binary label', async () => {
    exitSpy()
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const executors = Object.fromEntries(SHELL_COMMANDS.map((c) => [c.name, vi.fn() as Executor]))
    const registry = buildRegistry(SHELL_COMMANDS, executors)
    await expect(
      dispatch({ binary: 'caracal cli', version: '0.0.0', mode: 'dev', registry }, ['--help']),
    ).rejects.toThrow('exit:0')
    const out = stdout.mock.calls.map((c) => String(c[0])).join('')
    expect(out).toContain('Usage: caracal cli')
  })

  it('keeps CLI help limited to visible commands and global options', async () => {
    exitSpy()
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const executors = Object.fromEntries(CLI_COMMANDS.map((c) => [c.name, vi.fn() as Executor]))
    const registry = buildRegistry(CLI_COMMANDS, executors)
    await expect(
      dispatch({ binary: 'caracal-cli', version: '0.0.0', mode: 'dev', registry }, ['--help']),
    ).rejects.toThrow('exit:0')
    const out = stdout.mock.calls.map((c) => String(c[0])).join('')
    expect(out).toContain('zone')
    expect(out).toContain('control')
    expect(out).not.toMatch(/\brun\b/)
    expect(out).not.toMatch(/\bdebug\b/)
    expect(out).not.toMatch(/\bmanifest\b/)
    expect(out).not.toMatch(/\bcompletion\b/)
    expect(out).not.toContain('NO_COLOR')
    expect(out).not.toContain('--json')
  })
})
