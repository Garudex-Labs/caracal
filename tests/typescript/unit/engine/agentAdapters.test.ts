// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for governed agent adapters: launch plans, governance flag guards, and hook formats.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { GATEWAY_INJECTED_KEY, HOOK_TIMEOUT_SECONDS, agentAdapter, agentNames } from '../../../../packages/engine/src/agentAdapters.js'

const broker = 'http://127.0.0.1:41000/0123abcdef'
const protectedPaths = ['/home/richard/.ssh', '/home/richard/.config/caracal/anton-client-secret']
const launch = (args: string[]) => ({ command: 'claude', args, brokerUrl: broker, protectedPaths })

describe('agentAdapter', () => {
  it('resolves supported agents and rejects others', () => {
    expect(agentNames()).toContain('claude-code')
    expect(() => agentAdapter('pipernet-ai')).toThrow(/unsupported agent 'pipernet-ai'/)
  })
})

describe('claude-code adapter', () => {
  const adapter = agentAdapter('claude-code')

  it('routes model traffic and every tool hook through the broker', () => {
    const plan = adapter.plan(launch(['-p', 'fix the failing test']))
    expect(plan.argv.slice(0, 3)).toEqual(['claude', '-p', 'fix the failing test'])
    expect(plan.argv[3]).toBe('--settings')
    expect(JSON.parse(plan.argv[4]!)).toEqual({
      disableAllHooks: false,
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
      permissions: {
        deny: [
          'Read(//home/richard/.ssh)',
          'Read(//home/richard/.ssh/**)',
          'Read(//home/richard/.config/caracal/anton-client-secret)',
          'Read(//home/richard/.config/caracal/anton-client-secret/**)',
        ],
      },
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: `curl -fsS --max-time 8 -H 'content-type: application/json' --data-binary @- '${broker}/hooks/claude-code/pre-tool-use' || { echo 'caracal: tool decision unavailable' >&2; exit 2; }`,
                timeout: HOOK_TIMEOUT_SECONDS,
              },
            ],
          },
        ],
      },
    })
    expect(plan.env).toEqual({
      ANTHROPIC_BASE_URL: `${broker}/model`,
      ANTHROPIC_API_KEY: GATEWAY_INJECTED_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    })
  })

  it('needs the sandbox and hook executables where Claude Code can sandbox, and nothing runs elsewhere', () => {
    expect(adapter.requiredCommands('linux')).toEqual(['bwrap', 'socat', 'sh', 'curl'])
    expect(adapter.requiredCommands('darwin')).toEqual(['sandbox-exec', 'sh', 'curl'])
    expect(adapter.requiredCommands('win32')).toBeUndefined()
  })

  it('refuses a broker url that could escape the hook command quoting', () => {
    expect(() => adapter.plan({ ...launch([]), brokerUrl: "http://127.0.0.1:41000/x'; touch /tmp/pwn; '" })).toThrow(/unexpected hook url/)
  })

  it('refuses flags that can disable the hooks, in either spelling', () => {
    for (const args of [['--bare'], ['-p', 'hi', '--settings', '{}'], ['--settings={}'], ['--setting-sources', 'user']]) {
      expect(() => adapter.plan(launch(args))).toThrow(/is not allowed under a governed launch/)
    }
  })

  it('reads the tool name from the PreToolUse payload', () => {
    expect(adapter.toolName({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })).toBe('Bash')
    expect(adapter.toolName({ tool_name: '' })).toBeUndefined()
    expect(adapter.toolName({ tool_name: 7 })).toBeUndefined()
    expect(adapter.toolName(null)).toBeUndefined()
  })

  it('denies explicitly and otherwise defers to Claude Code permissions', () => {
    expect(adapter.hookResponse({ allow: true })).toEqual({})
    expect(adapter.hookResponse({ allow: false, reason: 'caracal: access_denied' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'caracal: access_denied' },
    })
  })
})

describe('openclaw adapter', () => {
  const adapter = agentAdapter('openclaw')
  const input = (args: string[]) => ({
    command: 'openclaw',
    args,
    brokerUrl: broker,
    protectedPaths,
    workspace: '/home/richard/pied-piper',
    stateDir: '/tmp/caracal-launch-x',
  })

  it('runs one pinned-config turn from the private launch directory', () => {
    const plan = adapter.plan(input(['fix the failing test', '--json']))
    expect(plan.argv).toEqual([
      'openclaw',
      'agent',
      'exec',
      'fix the failing test',
      '--json',
      '--config',
      '/tmp/caracal-launch-x/openclaw.json',
      '--cwd',
      '/home/richard/pied-piper',
      '--model',
      'caracal/claude-sonnet-5-5',
      '--code-mode',
      'direct',
    ])
    expect(plan.cwd).toBe('/tmp/caracal-launch-x')
    expect(plan.env).toEqual({ OPENCLAW_HOME: '/tmp/caracal-launch-x/home', OPENCLAW_EXEC_SHELL_SNAPSHOT: '0' })
    expect(adapter.requiredCommands('linux')).toEqual([])
  })

  it('routes the model through the broker with a credential-free provider and loads only the guard', () => {
    const config = JSON.parse(adapter.plan(input([])).files!['openclaw.json']!)
    expect(config.models).toMatchObject({
      mode: 'replace',
      providers: { caracal: { baseUrl: `${broker}/model`, api: 'anthropic-messages', apiKey: GATEWAY_INJECTED_KEY } },
    })
    expect(config.plugins).toEqual({
      enabled: true,
      allow: ['caracal-guard'],
      load: { paths: ['/tmp/caracal-launch-x/plugins/caracal-guard'] },
      entries: {
        'caracal-guard': {
          enabled: true,
          config: { hookUrl: `${broker}/hooks/openclaw/before-tool-call`, readyUrl: `${broker}/hooks/openclaw/ready` },
        },
      },
    })
    expect(config.tools.deny).toEqual(expect.arrayContaining(['plugins', 'openclaw', 'gateway']))
    expect(config.tools.elevated).toEqual({ enabled: false })
  })

  it('refuses flags that replace the pinned config or move the run off the broker', () => {
    for (const flag of ['--config=x.json', '--isolated', '--auth-env-only', '--model', '--fallback', '--cwd']) {
      expect(() => adapter.plan(input(['task', flag]))).toThrow(/is not allowed under a governed launch/)
    }
  })

  it('speaks the guard plugin decision format', () => {
    expect(adapter.toolName({ toolName: 'exec', toolKind: 'shell' })).toBe('exec')
    expect(adapter.toolName({ tool_name: 'exec' })).toBeUndefined()
    expect(adapter.hookResponse({ allow: true })).toEqual({ allow: true })
    expect(adapter.hookResponse({ allow: false, reason: 'caracal: access_denied' })).toEqual({
      allow: false,
      reason: 'caracal: access_denied',
    })
  })

  describe('guard plugin', () => {
    async function loadGuard(fetchImpl: typeof fetch) {
      const { mkdtempSync, writeFileSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { pathToFileURL } = await import('node:url')
      const dir = mkdtempSync(join(tmpdir(), 'caracal-guard-'))
      const file = join(dir, 'index.mjs')
      writeFileSync(file, adapter.plan(input([])).files!['plugins/caracal-guard/index.mjs']!)
      const guard = (await import(pathToFileURL(file).href)).default
      const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {}
      vi.stubGlobal('fetch', fetchImpl)
      guard.register({
        pluginConfig: { hookUrl: 'http://127.0.0.1:1/hook', readyUrl: 'http://127.0.0.1:1/ready' },
        on: (name: string, fn: never) => (handlers[name] = fn),
      })
      return { guard, beforeToolCall: handlers.before_tool_call! }
    }

    afterEach(() => vi.unstubAllGlobals())

    it('reports readiness and allows only on an explicit allow', async () => {
      const fetchMock = vi.fn(async (url: string) =>
        String(url).endsWith('/ready') ? new Response(null, { status: 204 }) : Response.json({ allow: true }),
      )
      const { guard, beforeToolCall } = await loadGuard(fetchMock as unknown as typeof fetch)
      expect(guard.id).toBe('caracal-guard')
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:1/ready', { method: 'POST' })
      expect(await beforeToolCall({ toolName: 'exec', toolCallId: 'call-1' }, {})).toBeUndefined()
      expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual({ toolName: 'exec', toolCallId: 'call-1' })
    })

    it('blocks on a denial, a non-allow answer, a broker error, or no broker', async () => {
      const answers: Array<() => Promise<Response>> = [
        async () => Response.json({ allow: false, reason: 'caracal: access_denied' }),
        async () => Response.json({}),
        async () => new Response('boom', { status: 502 }),
        async () => Promise.reject(new TypeError('fetch failed')),
      ]
      const reasons = []
      for (const answer of answers) {
        const { beforeToolCall } = await loadGuard((async (url: string) =>
          String(url).endsWith('/ready') ? new Response(null) : answer()) as unknown as typeof fetch)
        const result = (await beforeToolCall({ toolName: 'exec' }, {})) as { block?: boolean; blockReason?: string }
        expect(result.block).toBe(true)
        reasons.push(result.blockReason)
      }
      expect(reasons).toEqual([
        'caracal: access_denied',
        'caracal: tool call denied',
        'caracal: tool call denied',
        'caracal: tool decision unavailable',
      ])
    })
  })
})
