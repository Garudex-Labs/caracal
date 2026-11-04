// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for governed agent adapters: launch plans, governance flag guards, and hook formats.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  GATEWAY_INJECTED_KEY,
  HOOK_TIMEOUT_SECONDS,
  agentAdapter,
  agentNames,
  assertClaudeCodeManagedSettings,
} from '../../../../packages/engine/src/agentAdapters.js'

const broker = 'http://127.0.0.1:41000/0123abcdef'
const protectedPaths = ['/home/richard/.ssh', '/home/richard/.config/caracal/anton-client-secret']
const stateDir = '/tmp/caracal-launch-x'
const launch = (args: string[]) => ({ command: 'claude', args, brokerUrl: broker, protectedPaths, stateDir })

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
    expect(plan.argv[0]).toBe('claude')
    expect(plan.argv.slice(1)).toEqual(['--settings', `${stateDir}/claude-settings.json`, '-p', 'fix the failing test'])
    expect(plan.files!['claude-hook.curl']).toBe(`url = "${broker}/hooks/claude-code/pre-tool-use"\n`)
    expect(JSON.parse(plan.files!['claude-settings.json']!)).toEqual({
      disableAllHooks: false,
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
      permissions: {
        deny: [
          'Read(//home/richard/.ssh)',
          'Read(//home/richard/.ssh/**)',
          'Read(//home/richard/.config/caracal/anton-client-secret)',
          'Read(//home/richard/.config/caracal/anton-client-secret/**)',
          `Edit(/${stateDir}/**)`,
        ],
      },
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: `curl -fsS --max-time 8 -H 'content-type: application/json' --data-binary @- -K '${stateDir}/claude-hook.curl' || { echo 'caracal: tool decision unavailable' >&2; exit 2; }`,
                timeout: HOOK_TIMEOUT_SECONDS,
                onFailure: 'block',
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

  it('keeps the broker secret out of every process command line', () => {
    const plan = adapter.plan(launch(['-p', 'task']))
    const hook = JSON.parse(plan.files!['claude-settings.json']!).hooks.PreToolUse[0].hooks[0].command as string
    expect(plan.argv.join(' ')).not.toContain('0123abcdef')
    expect(hook).not.toContain('0123abcdef')
  })

  it('pins its settings before an option terminator in the caller args can make them positional', () => {
    const { argv } = adapter.plan(launch(['-p', 'task', '--']))
    expect(argv.indexOf('--settings')).toBeLessThan(argv.indexOf('--'))
  })

  it('needs the sandbox and hook executables where Claude Code can sandbox, and nothing runs elsewhere', () => {
    expect(adapter.requiredCommands('linux')).toEqual(['bwrap', 'socat', 'sh', 'curl', 'ps'])
    expect(adapter.requiredCommands('darwin')).toEqual(['sandbox-exec', 'sh', 'curl', 'ps'])
    expect(adapter.requiredCommands('win32')).toBeUndefined()
  })

  it('refuses a broker url that could escape the hook command quoting', () => {
    expect(() => adapter.plan({ ...launch([]), brokerUrl: "http://127.0.0.1:41000/x'; touch /tmp/pwn; '" })).toThrow(/unexpected hook url/)
  })

  it('refuses flags that can disable the hooks, in either spelling', () => {
    for (const args of [
      ['--bare'],
      ['-p', 'hi', '--settings', '{}'],
      ['--settings={}'],
      ['--setting-sources', 'user'],
      ['--managed-settings', '{"disableAllHooks":true}'],
      ['--managed-settings={}'],
    ]) {
      expect(() => adapter.plan(launch(args))).toThrow(/is not allowed under a governed launch/)
    }
  })

  it('refuses managed settings that would switch off the hook or sandbox', () => {
    const managed = (settings: unknown): string => {
      const dir = mkdtempSync(join(tmpdir(), 'caracal-managed-'))
      writeFileSync(join(dir, 'managed-settings.json'), JSON.stringify(settings))
      return dir
    }
    for (const [settings, name] of [
      [{ disableAllHooks: true }, 'disableAllHooks'],
      [{ allowManagedHooksOnly: true }, 'allowManagedHooksOnly'],
      [{ sandbox: { enabled: false } }, 'sandbox.enabled'],
      [{ sandbox: { allowUnsandboxedCommands: true } }, 'sandbox.allowUnsandboxedCommands'],
    ] as const) {
      expect(() => assertClaudeCodeManagedSettings(managed(settings))).toThrow(`set ${name}`)
    }
    expect(() => assertClaudeCodeManagedSettings(managed({ disableAllHooks: false, sandbox: { enabled: true } }))).not.toThrow()
  })

  it('checks managed drop-ins and allows a host with no managed settings', () => {
    const empty = mkdtempSync(join(tmpdir(), 'caracal-managed-'))
    expect(() => assertClaudeCodeManagedSettings(empty)).not.toThrow()
    const dir = mkdtempSync(join(tmpdir(), 'caracal-managed-'))
    mkdirSync(join(dir, 'managed-settings.d'))
    writeFileSync(join(dir, 'managed-settings.d', '10-org.json'), JSON.stringify({ disableAllHooks: true }))
    expect(() => assertClaudeCodeManagedSettings(dir)).toThrow('10-org.json set disableAllHooks')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a managed drop-in folder it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-managed-'))
    const dropIns = join(dir, 'managed-settings.d')
    mkdirSync(dropIns)
    chmodSync(dropIns, 0o000)
    onTestFinished(() => chmodSync(dropIns, 0o700))
    expect(() => assertClaudeCodeManagedSettings(dir)).toThrow(/cannot read managed settings/)
  })

  it('refuses managed settings it cannot parse rather than assuming they are safe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-managed-'))
    writeFileSync(join(dir, 'managed-settings.json'), '{ not json')
    expect(() => assertClaudeCodeManagedSettings(dir)).toThrow(/cannot parse managed settings/)
  })

  it('reads its version only from Claude Code output', () => {
    expect(adapter.versions!.pattern.exec('2.1.318 (Claude Code)\n')?.[1]).toBe('2.1.318')
    expect(adapter.versions!.pattern.exec('Running on an unsupported Node (22.23.1)\n')).toBeNull()
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

  it('pins its config before an option terminator in the caller args can make it positional', () => {
    const { argv } = adapter.plan(input(['task', '--']))
    expect(argv.indexOf('--config')).toBeLessThan(argv.indexOf('--'))
  })

  it('reads its version only from OpenClaw output', () => {
    expect(
      adapter.versions!.pattern.exec('Running on an unsupported Node (22.23.1); diagnostics off\nOpenClaw 2026.10.9 (8b18b55)\n')?.[1],
    ).toBe('2026.10.9')
  })

  it('runs one pinned-config turn from the private launch directory', () => {
    const plan = adapter.plan(input(['fix the failing test', '--json']))
    expect(plan.argv).toEqual([
      'openclaw',
      'agent',
      'exec',
      '--config',
      '/tmp/caracal-launch-x/openclaw.json',
      '--cwd',
      '/home/richard/pied-piper',
      '--model',
      'caracal/claude-sonnet-5-5',
      '--code-mode',
      'direct',
      'fix the failing test',
      '--json',
    ])
    expect(plan.cwd).toBe('/tmp/caracal-launch-x')
    expect(plan.env).toEqual({ OPENCLAW_HOME: '/tmp/caracal-launch-x/home', OPENCLAW_EXEC_SHELL_SNAPSHOT: '0' })
    expect(adapter.requiredCommands('linux')).toEqual(['ps'])
    expect(adapter.requiredCommands('win32')).toEqual([])
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
    async function loadGuard(fetchImpl: typeof fetch, on?: () => void) {
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
        on: on ?? ((name: string, fn: never) => (handlers[name] = fn)),
      })
      return { guard, beforeToolCall: handlers.before_tool_call! }
    }

    afterEach(() => vi.unstubAllGlobals())

    it('does not report ready when its hook cannot be registered', async () => {
      const fetchMock = vi.fn()
      const refuse = () => {
        throw new Error('hook registration failed')
      }
      await expect(loadGuard(fetchMock as unknown as typeof fetch, refuse)).rejects.toThrow('hook registration failed')
      expect(fetchMock).not.toHaveBeenCalled()
    })

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
