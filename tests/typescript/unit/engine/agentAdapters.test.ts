// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for governed agent adapters: launch plans, governance flag guards, and hook formats.

import { describe, expect, it } from 'vitest'
import { GATEWAY_INJECTED_KEY, HOOK_TIMEOUT_SECONDS, agentAdapter, agentNames } from '../../../../packages/engine/src/agentAdapters.js'

const broker = 'http://127.0.0.1:41000/0123abcd'

describe('agentAdapter', () => {
  it('resolves supported agents and rejects others', () => {
    expect(agentNames()).toContain('claude-code')
    expect(() => agentAdapter('pipernet-ai')).toThrow(/unsupported agent 'pipernet-ai'/)
  })
})

describe('claude-code adapter', () => {
  const adapter = agentAdapter('claude-code')

  it('routes model traffic and every tool hook through the broker', () => {
    const plan = adapter.plan('claude', ['-p', 'fix the failing test'], broker)
    expect(plan.argv.slice(0, 3)).toEqual(['claude', '-p', 'fix the failing test'])
    expect(plan.argv[3]).toBe('--settings')
    expect(JSON.parse(plan.argv[4]!)).toEqual({
      disableAllHooks: false,
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'http', url: `${broker}/hooks/claude-code/pre-tool-use`, timeout: HOOK_TIMEOUT_SECONDS }] },
        ],
      },
    })
    expect(plan.env).toEqual({
      ANTHROPIC_BASE_URL: `${broker}/model`,
      ANTHROPIC_API_KEY: GATEWAY_INJECTED_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    })
  })

  it('refuses flags that can disable the hooks, in either spelling', () => {
    for (const args of [['--bare'], ['-p', 'hi', '--settings', '{}'], ['--settings={}'], ['--setting-sources', 'user']]) {
      expect(() => adapter.plan('claude', args, broker)).toThrow(/is not allowed under a governed launch/)
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
