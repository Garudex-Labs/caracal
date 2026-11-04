// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for governed agent adapters: launch plans, governance flag guards, and hook formats.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'
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
