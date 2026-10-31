// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for governed agent launch: Session and delegation shape, tool decisions, and supervision.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAdapter } from '../../../../packages/engine/src/agentAdapters.js'
import { agentAdapter } from '../../../../packages/engine/src/agentAdapters.js'

interface FakeSession {
  sessionId: string
  context: { sessionId: string }
  close: ReturnType<typeof vi.fn>
  opts: Record<string, unknown>
}

const sdk = vi.hoisted(() => ({
  env: undefined as NodeJS.ProcessEnv | undefined,
  sessions: [] as FakeSession[],
  closed: [] as string[],
  bound: [] as string[],
  startSession: vi.fn(),
  delegate: vi.fn(),
  acceptDelegation: vi.fn(),
  mintMandate: vi.fn(),
  fetch: vi.fn(),
  close: vi.fn(),
}))

vi.mock('@caracalai/sdk', () => ({
  Authority: {
    none: () => ({ mode: 'none' }),
    narrow: (scopes: string[], opts: unknown) => ({ mode: 'narrow', scopes, opts }),
  },
  Caracal: {
    fromEnv: (env: NodeJS.ProcessEnv) => {
      sdk.env = env
      let current: string | undefined
      return {
        identity: async () => ({ zoneId: 'zone-pied-piper', applicationId: 'app-anton' }),
        bind: async (ctx: { sessionId: string }, fn: () => Promise<unknown>) => {
          sdk.bound.push(ctx.sessionId)
          const previous = current
          current = ctx.sessionId
          try {
            return await fn()
          } finally {
            current = previous
          }
        },
        startSession: (opts: Record<string, unknown>) => sdk.startSession(opts, current),
        delegate: (opts: unknown) => sdk.delegate(opts, current),
        acceptDelegation: (id: string, fn: () => Promise<unknown>) => sdk.acceptDelegation(id, current, fn),
        mintMandate: (resource: string, scopes: string[]) => sdk.mintMandate(resource, scopes, current),
        fetch: (resource: string, path: string, init: unknown) => sdk.fetch(resource, path, init, current),
        close: sdk.close,
      }
    },
  },
}))

const { launchAgent, protectedPaths } = await import('../../../../packages/engine/src/agentLaunch.js')

// Stand-ins for the sandbox and hook executables the launcher checks for on PATH.
const sandboxBin = mkdtempSync(join(tmpdir(), 'caracal-sandbox-bin-'))
for (const name of ['bwrap', 'socat', 'sh', 'curl', 'sandbox-exec']) writeFileSync(join(sandboxBin, name), '')

const profile = {
  model: { resource: 'resource://pipernet-models', scopes: ['models:invoke'] },
  tools: { resource: 'resource://claude-code-tools', scopes: ['tool:Read', 'tool:Bash'] },
}

// A stand-in agent: a Node process that runs `script`, launched through the real adapter plan.
function fakeAgent(script: string, seen: { brokerUrl?: string; protectedPaths?: string[] } = {}): AgentAdapter {
  const base = agentAdapter('claude-code')
  return {
    ...base,
    plan: ({ brokerUrl, protectedPaths }) => {
      seen.brokerUrl = brokerUrl
      seen.protectedPaths = protectedPaths
      return { argv: [process.execPath, '-e', script], env: {} }
    },
  }
}

beforeEach(() => {
  sdk.sessions = []
  sdk.closed = []
  sdk.bound = []
  for (const fn of [sdk.startSession, sdk.delegate, sdk.acceptDelegation, sdk.mintMandate, sdk.fetch, sdk.close]) fn.mockReset()
  sdk.startSession.mockImplementation(async (opts: Record<string, unknown>, parent: string | undefined) => {
    const id = parent ? 'session-agent' : 'session-launcher'
    const session: FakeSession = { sessionId: id, context: { sessionId: id }, opts, close: vi.fn(async () => void sdk.closed.push(id)) }
    sdk.sessions.push(session)
    return session
  })
  sdk.delegate.mockResolvedValue({ delegationId: 'edge-tools', scopes: profile.tools.scopes })
  sdk.acceptDelegation.mockImplementation(async (_id: string, _current: string, fn: () => Promise<unknown>) => fn())
  sdk.mintMandate.mockResolvedValue({ token: 'mandate' })
})

describe('protectedPaths', () => {
  it('covers home credential stores and Caracal locations named in the environment', () => {
    const paths = protectedPaths({
      HOME: '/home/richard',
      CARACAL_APP_CLIENT_SECRET_FILE: '/run/secrets/anton-client-secret',
      CARACAL_SECRETS_DIR: '/srv/caracal/secrets',
    })
    for (const path of [
      '/home/richard/.config/caracal',
      '/home/richard/.local/share/caracal',
      '/home/richard/.claude/.credentials.json',
      '/home/richard/.ssh',
      '/home/richard/.aws',
      '/home/richard/.config/gh',
      '/run/secrets/anton-client-secret',
      '/srv/caracal/secrets',
    ]) {
      expect(paths).toContain(path)
    }
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('skips home stores when no absolute home directory is known', () => {
    expect(protectedPaths({ HOME: 'relative/home' })).toEqual([])
    expect(protectedPaths({})).toEqual([])
  })
})

describe('launchAgent', () => {
  it('runs the agent under a delegated Session and resolves its exit code', async () => {
    const code = await launchAgent({
      adapter: fakeAgent('process.exit(3)'),
      profile,
      args: [],
      env: { PATH: sandboxBin, CARACAL_APP_RESOURCES: 'resource://hoolibox' },
    })

    expect(code).toBe(3)
    expect(sdk.env?.CARACAL_APP_RESOURCES).toBe('resource://hoolibox,resource://pipernet-models,resource://claude-code-tools')
    const [launcher, agent] = sdk.sessions
    expect(launcher!.opts).toMatchObject({ labels: ['app-anton'], authority: { mode: 'none' }, heartbeatIntervalMs: 5000 })
    expect(agent!.opts).toMatchObject({
      labels: ['app-anton'],
      authority: { mode: 'narrow', scopes: ['models:invoke'], opts: { resourceId: 'resource://pipernet-models', ttlSeconds: 28800 } },
    })
    expect(sdk.startSession.mock.calls[1]![1]).toBe('session-launcher')
    expect(sdk.delegate).toHaveBeenCalledWith(
      { toSessionId: 'session-agent', resourceId: 'resource://claude-code-tools', scopes: ['tool:Read', 'tool:Bash'], ttlSeconds: 28800 },
      'session-launcher',
    )
    expect(sdk.closed).toEqual(['session-agent', 'session-launcher'])
    expect(sdk.close).toHaveBeenCalledOnce()
  })

  it('hands the adapter the credential stores to protect', async () => {
    const seen: { protectedPaths?: string[] } = {}
    await launchAgent({ adapter: fakeAgent('process.exit(0)', seen), profile, args: [], env: { PATH: sandboxBin, HOME: '/home/richard' } })
    expect(seen.protectedPaths).toContain('/home/richard/.ssh')
  })

  it('writes plan files owner-only into a private launch directory and removes it afterwards', async () => {
    const { existsSync, readFileSync } = await import('node:fs')
    const report = join(mkdtempSync(join(tmpdir(), 'caracal-plan-report-')), 'report.json')
    // The agent records what it sees from its own working directory, the launch directory.
    const script = [
      "const fs = require('node:fs')",
      "const file = 'nested/config.json'",
      `fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ cwd: process.cwd(), mode: fs.statSync(file).mode & 0o777, dirMode: fs.statSync('.').mode & 0o777, content: fs.readFileSync(file, 'utf8') }))`,
    ].join(';')
    let seen: { stateDir?: string; workspace?: string } = {}
    const adapter: AgentAdapter = {
      ...agentAdapter('claude-code'),
      plan: ({ stateDir, workspace }) => {
        seen = { stateDir, workspace }
        return { argv: [process.execPath, '-e', script], env: {}, cwd: stateDir, files: { 'nested/config.json': '{"guard":true}' } }
      },
    }

    expect(await launchAgent({ adapter, profile, args: [], env: { PATH: sandboxBin }, cwd: '/tmp' })).toBe(0)

    const observed = JSON.parse(readFileSync(report, 'utf8'))
    expect(seen.workspace).toBe('/tmp')
    expect(observed).toEqual({ cwd: seen.stateDir, mode: 0o600, dirMode: 0o700, content: '{"guard":true}' })
    expect(existsSync(seen.stateDir!)).toBe(false)
  })

  it('uses profile labels for grant matching when given', async () => {
    await launchAgent({
      adapter: fakeAgent('process.exit(0)'),
      profile: { ...profile, labels: ['payout-review'] },
      args: [],
      env: { PATH: sandboxBin },
    })
    expect(sdk.sessions.map((s) => s.opts.labels)).toEqual([['payout-review'], ['payout-review']])
  })

  it('decides each tool call by minting its scope under the tools delegation as the agent', async () => {
    const seen: { brokerUrl?: string } = {}
    const run = launchAgent({
      adapter: fakeAgent('setInterval(() => {}, 1e6)', seen),
      profile,
      args: [],
      env: { PATH: sandboxBin },
      onLine: () => {},
    })
    await vi.waitFor(() => expect(seen.brokerUrl).toBeDefined())
    const res = await fetch(`${seen.brokerUrl}/hooks/claude-code/pre-tool-use`, {
      method: 'POST',
      body: JSON.stringify({ tool_name: 'Bash' }),
    })
    expect(await res.json()).toEqual({})
    expect(sdk.acceptDelegation).toHaveBeenCalledWith('edge-tools', 'session-agent', expect.any(Function))
    expect(sdk.mintMandate).toHaveBeenCalledWith('resource://claude-code-tools', ['tool:Bash'], 'session-agent')

    ;(sdk.sessions[1]!.opts.onLeaseLost as (err: unknown) => void)(new Error('gone'))
    await run
  })

  it('stops the agent tree when its Session is terminated and still tears everything down', async () => {
    const lines: string[] = []
    const seen: { brokerUrl?: string } = {}
    const run = launchAgent({
      adapter: fakeAgent('setInterval(() => {}, 1e6)', seen),
      profile,
      args: [],
      env: { PATH: sandboxBin },
      onLine: (l) => lines.push(l),
    })
    await vi.waitFor(() => expect(seen.brokerUrl).toBeDefined())

    ;(sdk.sessions[1]!.opts.onLeaseLost as (err: unknown) => void)(new Error('session_not_live'))
    const code = await run

    expect(code).toBe(143)
    expect(lines).toContain('caracal: stopping claude-code: agent Session ended')
    expect(sdk.closed).toEqual(['session-agent', 'session-launcher'])
    await expect(fetch(`${seen.brokerUrl}/hooks/claude-code/pre-tool-use`, { method: 'POST', body: '{}' })).rejects.toThrow()
  })

  it('refuses to start without the sandbox and hook executables', async () => {
    const partial = mkdtempSync(join(tmpdir(), 'caracal-partial-bin-'))
    writeFileSync(join(partial, 'curl'), '')
    writeFileSync(join(partial, 'sh'), '')
    const adapter = { ...agentAdapter('claude-code'), requiredCommands: () => ['bwrap', 'socat', 'sh', 'curl'] }
    await expect(launchAgent({ adapter, profile, args: [], env: { PATH: partial } })).rejects.toThrow(
      'claude-code: bwrap, socat not found on PATH',
    )
    expect(sdk.startSession).not.toHaveBeenCalled()
  })

  it('refuses platforms where the agent cannot be sandboxed', async () => {
    const adapter = { ...agentAdapter('claude-code'), requiredCommands: () => undefined }
    await expect(launchAgent({ adapter, profile, args: [], env: { PATH: sandboxBin } })).rejects.toThrow(/not supported on/)
    expect(sdk.startSession).not.toHaveBeenCalled()
  })

  it('retires the launcher Session when the agent Session cannot start', async () => {
    sdk.startSession.mockImplementationOnce(async (opts: Record<string, unknown>) => {
      const session: FakeSession = {
        sessionId: 'session-launcher',
        context: { sessionId: 'session-launcher' },
        opts,
        close: vi.fn(async () => void sdk.closed.push('session-launcher')),
      }
      sdk.sessions.push(session)
      return session
    })
    sdk.startSession.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'access_denied' }))
    const plan = vi.fn()
    await expect(
      launchAgent({ adapter: { ...agentAdapter('claude-code'), plan }, profile, args: [], env: { PATH: sandboxBin } }),
    ).rejects.toThrow('denied')
    expect(plan).not.toHaveBeenCalled()
    expect(sdk.closed).toEqual(['session-launcher'])
    expect(sdk.close).toHaveBeenCalledOnce()
  })
})
