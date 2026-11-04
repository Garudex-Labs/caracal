// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for governed agent launch: Session and delegation shape, tool decisions, and supervision.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

// Launch tests use stand-in agents, which have no version to check.
const claudeCode = { ...agentAdapter('claude-code'), versions: undefined }

const { launchAgent, protectedPaths } = await import('../../../../packages/engine/src/agentLaunch.js')

// Stand-ins for the sandbox and hook executables the launcher checks for on PATH.
const sandboxBin = mkdtempSync(join(tmpdir(), 'caracal-sandbox-bin-'))
for (const name of ['bwrap', 'socat', 'sh', 'curl', 'ps', 'sandbox-exec']) writeFileSync(join(sandboxBin, name), '', { mode: 0o755 })

const profile = {
  model: { resource: 'resource://pipernet-models', scopes: ['models:invoke'] },
  tools: { resource: 'resource://claude-code-tools', scopes: ['tool:Read', 'tool:Bash'] },
}

// A stand-in agent: a Node process that runs `script`, launched through the real adapter plan.
function fakeAgent(script: string, seen: { brokerUrl?: string; protectedPaths?: string[] } = {}): AgentAdapter {
  return {
    ...claudeCode,
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

  it('writes plan files owner-only and removes the launch directory afterwards', async () => {
    const { existsSync } = await import('node:fs')
    const report = join(mkdtempSync(join(tmpdir(), 'caracal-plan-report-')), 'report.json')
    let dir = ''
    const adapter: AgentAdapter = {
      ...claudeCode,
      plan: ({ stateDir }) => {
        dir = stateDir
        const script = `const fs = require('node:fs'); const f = ${JSON.stringify(join(stateDir, 'nested/c.json'))}; fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ mode: fs.statSync(f).mode & 0o777, dirMode: fs.statSync(${JSON.stringify(stateDir)}).mode & 0o777, content: fs.readFileSync(f, 'utf8') }))`
        return { argv: [process.execPath, '-e', script], env: {}, files: { 'nested/c.json': '{"pinned":true}' } }
      },
    }
    expect(await launchAgent({ adapter, profile, args: [], env: { PATH: sandboxBin } })).toBe(0)
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({ mode: 0o600, dirMode: 0o700, content: '{"pinned":true}' })
    expect(existsSync(dir)).toBe(false)
  })

  it('refuses a plan file outside the launch directory', async () => {
    const adapter: AgentAdapter = {
      ...claudeCode,
      plan: () => ({ argv: [process.execPath, '-e', 'process.exit(0)'], env: {}, files: { '../outside.json': '{}' } }),
    }
    await expect(launchAgent({ adapter, profile, args: [], env: { PATH: sandboxBin } })).rejects.toThrow(/outside the launch directory/)
    expect(sdk.closed).toEqual(['session-agent', 'session-launcher'])
  })

  it('runs an agent from the working directory its plan names', async () => {
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
      ...claudeCode,
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

  it('forwards model calls as the agent Session with only the model scopes', async () => {
    sdk.fetch.mockImplementation(async () => new Response('{"ok":true}'))
    const seen: { brokerUrl?: string } = {}
    const run = launchAgent({ adapter: fakeAgent('setInterval(() => {}, 1e6)', seen), profile, args: [], env: { PATH: sandboxBin } })
    await vi.waitFor(() => expect(seen.brokerUrl).toBeDefined())
    const res = await fetch(`${seen.brokerUrl}/model/v1/messages?beta=true`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    const [resource, path, init, session] = sdk.fetch.mock.calls[0] as [string, string, { scopes: string[] }, string]
    expect({ resource, path, scopes: init.scopes, session }).toEqual({
      resource: 'resource://pipernet-models',
      path: '/v1/messages?beta=true',
      scopes: ['models:invoke'],
      session: 'session-agent',
    })
    ;(sdk.sessions[1]!.opts.onLeaseLost as (err: unknown) => void)(new Error('done'))
    await run
  })

  it('stops the agent when its delegated authority expires', async () => {
    const lines: string[] = []
    const code = await launchAgent({
      adapter: fakeAgent('setInterval(() => {}, 1e6)'),
      profile,
      args: [],
      env: { PATH: sandboxBin },
      ttlSeconds: 0.3,
      onLine: (l) => lines.push(l),
    })
    expect(code).toBe(143)
    expect(lines).toContain('caracal: stopping claude-code: delegated authority expired')
    expect(sdk.closed).toEqual(['session-agent', 'session-launcher'])
  })

  describe('agent version', () => {
    const versioned = (printed: string) => {
      const command = join(mkdtempSync(join(tmpdir(), 'caracal-version-')), 'agent')
      writeFileSync(command, `#!/bin/sh\necho '${printed}'\n`, { mode: 0o755 })
      return command
    }
    const adapter = {
      ...claudeCode,
      versions: { pattern: /^(\d+\.\d+\.\d+) \(Agent\)/m, minimum: '2.1.10', tested: '2.1.20' },
      plan: () => ({ argv: [process.execPath, '-e', 'process.exit(0)'], env: {} }),
    }

    it.skipIf(process.platform === 'win32')('refuses an agent older than the oldest verified version, comparing numerically', async () => {
      await expect(
        launchAgent({ adapter, profile, args: [], env: { PATH: sandboxBin }, command: versioned('2.1.9 (Agent)') }),
      ).rejects.toThrow(/older than 2\.1\.10/)
      expect(sdk.startSession).not.toHaveBeenCalled()
    })

    it.skipIf(process.platform === 'win32')('refuses an agent whose version it cannot read', async () => {
      await expect(
        launchAgent({ adapter, profile, args: [], env: { PATH: sandboxBin }, command: versioned('Running on Node (22.23.1)') }),
      ).rejects.toThrow(/cannot read the version/)
      expect(sdk.startSession).not.toHaveBeenCalled()
    })

    it.skipIf(process.platform === 'win32')('warns about a newer agent and still launches it', async () => {
      const lines: string[] = []
      const code = await launchAgent({
        adapter,
        profile,
        args: [],
        env: { PATH: sandboxBin },
        command: versioned('2.1.30 (Agent)'),
        onLine: (l) => lines.push(l),
      })
      expect(code).toBe(0)
      expect(lines).toContain('caracal: claude-code 2.1.30 is newer than 2.1.20, the newest verified version')
    })

    it.skipIf(process.platform === 'win32')('keeps launcher credentials out of the version check', async () => {
      const out = join(mkdtempSync(join(tmpdir(), 'caracal-version-env-')), 'env')
      const command = versioned('2.1.20 (Agent)')
      writeFileSync(command, `#!/bin/sh\nset > ${out}\necho '2.1.20 (Agent)'\n`, { mode: 0o755 })
      await launchAgent({ adapter, profile, args: [], env: { PATH: sandboxBin, CARACAL_APP_CLIENT_SECRET: 'piper-secret' }, command })
      const seen = readFileSync(out, 'utf8')
      expect(seen).toContain(sandboxBin)
      expect(seen).not.toContain('piper-secret')
    })
  })

  it('refuses to start when host policy would switch off governance', async () => {
    const adapter = {
      ...claudeCode,
      requiredCommands: () => [],
      assertHostPolicy: () => {
        throw new Error('claude-code: managed settings set disableAllHooks')
      },
    }
    await expect(launchAgent({ adapter, profile, args: [], env: { PATH: sandboxBin } })).rejects.toThrow(/disableAllHooks/)
    expect(sdk.startSession).not.toHaveBeenCalled()
  })

  it('runs the agent with the PATH its requirements were checked against', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'caracal-path-out-')), 'path')
    const script = `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.PATH)`
    await launchAgent({ adapter: fakeAgent(script), profile, args: [], env: { PATH: sandboxBin } })
    expect(readFileSync(out, 'utf8')).toBe(sandboxBin)
  })

  it('refuses to start without the sandbox and hook executables', async () => {
    const partial = mkdtempSync(join(tmpdir(), 'caracal-partial-bin-'))
    writeFileSync(join(partial, 'curl'), '', { mode: 0o755 })
    writeFileSync(join(partial, 'sh'), '', { mode: 0o755 })
    const adapter = { ...claudeCode, requiredCommands: () => ['bwrap', 'socat', 'sh', 'curl'] }
    await expect(launchAgent({ adapter, profile, args: [], env: { PATH: partial } })).rejects.toThrow(
      'claude-code: bwrap, socat not found on PATH',
    )
    expect(sdk.startSession).not.toHaveBeenCalled()
  })

  it('refuses platforms where the agent cannot be sandboxed', async () => {
    const adapter = { ...claudeCode, requiredCommands: () => undefined }
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
    await expect(launchAgent({ adapter: { ...claudeCode, plan }, profile, args: [], env: { PATH: sandboxBin } })).rejects.toThrow('denied')
    expect(plan).not.toHaveBeenCalled()
    expect(sdk.closed).toEqual(['session-launcher'])
    expect(sdk.close).toHaveBeenCalledOnce()
  })
})
