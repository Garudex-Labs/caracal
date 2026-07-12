// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime shell entrypoint tests verify command wiring and registry filtering.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeIdentity } from '../../../../apps/runtime/src/config.ts'

const state = vi.hoisted(() => ({
  dispatch: vi.fn(),
  installCrashHandlers: vi.fn(),
  runCommand: vi.fn(),
  upCommand: vi.fn(),
  downCommand: vi.fn(),
  statusCommand: vi.fn(),
  upgradeCommand: vi.fn(),
  purgeCommand: vi.fn(),
  allowlistCommand: vi.fn(),
  webCommand: vi.fn(),
  webInterfaceAvailable: vi.fn(() => true),
}))

vi.mock('@caracalai/engine/scrubCwdEnv', () => ({}))
vi.mock('@caracalai/engine/operatorEnv', () => ({ loadOperatorEnv: vi.fn(() => []) }))
vi.mock('@caracalai/engine/crash', () => ({ installCrashHandlers: state.installCrashHandlers }))
vi.mock('@caracalai/engine/commands', () => ({
  SHELL_COMMANDS: [
    { name: 'up', summary: 'up', group: 'stack' },
    { name: 'down', summary: 'down', group: 'stack' },
    { name: 'status', summary: 'status', group: 'stack' },
    { name: 'upgrade', summary: 'upgrade', group: 'stack' },
    { name: 'purge', summary: 'purge', group: 'runtime' },
    { name: 'allowlist', summary: 'allowlist', group: 'stack', requiresArgs: true },
    { name: 'run', summary: 'run', group: 'runtime', requiresArgs: true, requiresConfig: true },
    { name: 'web', summary: 'web', group: 'runtime' },
  ],
}))
vi.mock('../../../../apps/runtime/src/runtime/version.gen.ts', () => ({
  CARACAL_MODE: 'dev',
  CARACAL_SHA: 'sha-test',
  CARACAL_VERSION: '0.0.0-test',
}))
vi.mock('../../../../apps/runtime/src/commands/run.ts', () => ({ runCommand: state.runCommand }))
vi.mock('../../../../apps/runtime/src/commands/stack.ts', () => ({
  upCommand: state.upCommand,
  downCommand: state.downCommand,
  statusCommand: state.statusCommand,
  upgradeCommand: state.upgradeCommand,
}))
vi.mock('../../../../apps/runtime/src/commands/purge.ts', () => ({ purgeCommand: state.purgeCommand }))
vi.mock('../../../../apps/runtime/src/commands/allowlist.ts', () => ({ allowlistCommand: state.allowlistCommand }))
vi.mock('../../../../apps/runtime/src/commands/web.ts', () => ({
  webCommand: state.webCommand,
  webInterfaceAvailable: state.webInterfaceAvailable,
}))
vi.mock('../../../../apps/runtime/src/dispatcher.ts', () => ({ dispatch: state.dispatch }))

async function importShell(): Promise<Awaited<ReturnType<typeof loadShell>>> {
  vi.resetModules()
  return loadShell()
}

async function loadShell() {
  await import('../../../../apps/runtime/src/shell.ts')
  const opts = state.dispatch.mock.calls.at(-1)?.[0]
  return opts
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('runtime shell entrypoint', () => {
  it('installs crash handlers and dispatches the filtered runtime registry', async () => {
    const opts = await importShell()

    expect(state.installCrashHandlers).toHaveBeenCalledWith('caracal')
    expect(state.webInterfaceAvailable).toHaveBeenCalledOnce()
    expect(state.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        binary: 'caracal',
        version: '0.0.0-test',
        mode: 'dev',
        sha: 'sha-test',
        loadConfig: true,
      }),
      process.argv.slice(2),
    )
    expect(opts.registry.byName.has('web')).toBe(true)
  })

  it('wires stack, purge, and run executors without exposing unavailable interfaces', async () => {
    state.webInterfaceAvailable.mockReturnValueOnce(false)
    const opts = await importShell()
    const cfg = { sts_url: 'https://sts.example.com' } as RuntimeIdentity

    expect(opts.registry.byName.has('web')).toBe(false)
    await opts.registry.byName.get('up')!.run(['--detach'], cfg)
    await opts.registry.byName.get('down')!.run(['--volumes'], cfg)
    await opts.registry.byName.get('status')!.run(['--json'], cfg)
    await opts.registry.byName.get('purge')!.run(['--force'], cfg)
    await opts.registry.byName.get('allowlist')!.run(['add', 'richard.hendricks@piedpiper.example'], cfg)
    await opts.registry.byName.get('run')!.run(['--', 'node', 'tool.js'], cfg)

    expect(state.upCommand).toHaveBeenCalledWith(['--detach'])
    expect(state.downCommand).toHaveBeenCalledWith(['--volumes'])
    expect(state.statusCommand).toHaveBeenCalledWith(['--json'])
    expect(state.purgeCommand).toHaveBeenCalledWith(['--force'])
    expect(state.allowlistCommand).toHaveBeenCalledWith(['add', 'richard.hendricks@piedpiper.example'])
    expect(state.runCommand).toHaveBeenCalledWith(['--', 'node', 'tool.js'], cfg)
  })

  it('routes run and web straight to their executors', async () => {
    const opts = await importShell()

    await opts.registry.byName.get('run')!.run([], undefined)
    await opts.registry.byName.get('run')!.run(['python', 'tool.py'], undefined)
    await opts.registry.byName.get('web')!.run(['--allow-offline'])

    expect(state.runCommand).toHaveBeenCalledWith([], undefined)
    expect(state.runCommand).toHaveBeenCalledWith(['python', 'tool.py'], undefined)
    expect(state.webCommand).toHaveBeenCalledWith(['--allow-offline'])
  })
})
