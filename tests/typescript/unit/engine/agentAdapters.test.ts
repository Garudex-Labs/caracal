// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for governed agent adapters: launch plans, governance flag guards, and hook formats.

import { describe, expect, it } from 'vitest'
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
