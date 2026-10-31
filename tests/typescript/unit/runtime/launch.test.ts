// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime launch command unit tests for argument parsing, profile resolution, and exit codes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  launchAgent: vi.fn(),
  readAgentProfile: vi.fn(),
  agentAdapter: vi.fn(),
}))

vi.mock('@caracalai/engine', () => ({
  launchAgent: engine.launchAgent,
  readAgentProfile: engine.readAgentProfile,
  agentAdapter: engine.agentAdapter,
  agentNames: () => ['claude-code'],
}))

import { launchCommand } from '../../../../apps/runtime/src/commands/launch.js'

const profile = {
  model: { resource: 'resource://pipernet-models', scopes: ['models:invoke'] },
  tools: { resource: 'resource://claude-code-tools', scopes: ['tool:Read'] },
}

describe('launchCommand', () => {
  let stderr = ''
  let stdout = ''
  let profileEnv: string | undefined

  beforeEach(() => {
    stderr = ''
    stdout = ''
    profileEnv = process.env.CARACAL_AGENT_PROFILE
    delete process.env.CARACAL_AGENT_PROFILE
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString()
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    })
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`)
    })
    engine.agentAdapter.mockImplementation((name: string) => ({ name }))
    engine.readAgentProfile.mockReturnValue(profile)
    engine.launchAgent.mockResolvedValue(0)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const fn of Object.values(engine)) fn.mockReset()
    if (profileEnv === undefined) delete process.env.CARACAL_AGENT_PROFILE
    else process.env.CARACAL_AGENT_PROFILE = profileEnv
  })

  it('prints help listing the supported agents', async () => {
    await expect(launchCommand(['--help'])).rejects.toThrow('exit:0')
    expect(stdout).toContain('Usage: caracal launch <agent>')
    expect(stdout).toContain('Agents: claude-code')
    expect(engine.launchAgent).not.toHaveBeenCalled()
  })

  it('launches the agent with its profile and passes agent args through verbatim', async () => {
    engine.launchAgent.mockResolvedValueOnce(7)
    await expect(
      launchCommand([
        'claude-code',
        '--profile',
        'anton.json',
        '--command=/opt/claude/bin/claude',
        '--',
        '-p',
        'fix the failing test',
        '--',
        'x',
      ]),
    ).rejects.toThrow('exit:7')
    expect(engine.readAgentProfile).toHaveBeenCalledWith('anton.json')
    expect(engine.launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: { name: 'claude-code' },
        profile,
        args: ['-p', 'fix the failing test', '--', 'x'],
        command: '/opt/claude/bin/claude',
        env: process.env,
      }),
    )
  })

  it('falls back to CARACAL_AGENT_PROFILE', async () => {
    process.env.CARACAL_AGENT_PROFILE = '/home/richard/pied-piper/anton.json'
    await expect(launchCommand(['claude-code'])).rejects.toThrow('exit:0')
    expect(engine.readAgentProfile).toHaveBeenCalledWith('/home/richard/pied-piper/anton.json')
  })

  it('fails before launching on missing inputs or unknown options', async () => {
    for (const [argv, message] of [
      [['claude-code'], 'a launch profile is required'],
      [['--profile', 'anton.json'], 'an agent name is required'],
      [['claude-code', '--profile'], '--profile requires a value'],
      [['claude-code', '--profile', 'anton.json', '-p', 'hi'], "unknown option '-p'; pass agent arguments after --"],
    ] as const) {
      stderr = ''
      await expect(launchCommand([...argv])).rejects.toThrow('exit:1')
      expect(stderr).toContain(message)
    }
    expect(engine.launchAgent).not.toHaveBeenCalled()
  })

  it('reports launch failures without leaving an agent running', async () => {
    engine.launchAgent.mockRejectedValueOnce(
      new Error("claude-code: --bare is not allowed under a governed launch because it can disable Caracal's tool hooks"),
    )
    await expect(launchCommand(['claude-code', '--profile', 'anton.json', '--', '--bare'])).rejects.toThrow('exit:1')
    expect(stderr).toContain('--bare is not allowed')
  })
})
