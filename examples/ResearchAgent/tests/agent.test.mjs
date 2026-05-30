// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Offline sanity tests for the real-provider caracal run example.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXAMPLE_ROOT = join(__dirname, '..')
const AGENT = join(EXAMPLE_ROOT, 'agent.mjs')
const README = join(EXAMPLE_ROOT, 'README.md')
const ENV_EXAMPLE = join(EXAMPLE_ROOT, 'env.example')

const BASE_ENV = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TERM']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
)

function runNode(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, args, {
      env: { ...BASE_ENV, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

describe('real-provider example contract', () => {
  it('keeps the agent syntax valid without starting network calls', async () => {
    const { code, stderr } = await runNode(['--check', AGENT])
    assert.equal(code, 0, stderr)
  })

  it('fails before network access when Google Drive OAuth is not injected', async () => {
    const { code, stderr } = await runNode([AGENT, 'task'])
    assert.equal(code, 2)
    assert.match(stderr, /GOOGLE_DRIVE_ACCESS_TOKEN is not set/)
  })

  it('fails before network access when Google Calendar OAuth is not injected', async () => {
    const { code, stderr } = await runNode([AGENT, 'task'], {
      GOOGLE_DRIVE_ACCESS_TOKEN: 'ya29.real-drive-token',
    })
    assert.equal(code, 2)
    assert.match(stderr, /GOOGLE_CALENDAR_ACCESS_TOKEN is not set/)
  })

  it('fails before network access when OpenAI is not injected', async () => {
    const { code, stderr } = await runNode([AGENT, 'task'], {
      GOOGLE_DRIVE_ACCESS_TOKEN: 'ya29.real-drive-token',
      GOOGLE_CALENDAR_ACCESS_TOKEN: 'ya29.real-calendar-token',
    })
    assert.equal(code, 2)
    assert.match(stderr, /OPENAI_API_KEY is not set/)
  })

  it('documents real providers and resource mappings', async () => {
    const readme = await readFile(README, 'utf8')
    assert.match(readme, /https:\/\/www.googleapis.com/)
    assert.match(readme, /https:\/\/api.openai.com\/v1/)
    assert.match(readme, /resource:\/\/google-drive/)
    assert.match(readme, /resource:\/\/google-calendar/)
    assert.match(readme, /resource:\/\/openai/)
    assert.match(readme, /allow_runtime_injection = true/)
    assert.match(readme, /CARACAL_CONFIG/)
    assert.match(readme, /runtime\/<zone_id>\/<application_id>/)
    assert.match(readme, /CARACAL_RUN_TTL_SECONDS/)
    assert.match(readme, /GPT-5\.4 mini/)
    assert.doesNotMatch(readme, /--google-base-url/)
    assert.doesNotMatch(readme, /--openai-base-url/)
    assert.doesNotMatch(readme, /--model/)
  })

  it('ships a bootstrap-only environment example', async () => {
    const envExample = await readFile(ENV_EXAMPLE, 'utf8')
    assert.match(envExample, /CARACAL_ZONE_ID/)
    assert.match(envExample, /CARACAL_APPLICATION_ID/)
    assert.match(envExample, /CARACAL_RUN_TTL_SECONDS="900"/)
    assert.doesNotMatch(envExample, /^export CARACAL_.*URL=/m)
    assert.doesNotMatch(envExample, /^export .*SECRET.*FILE=/m)
    assert.doesNotMatch(envExample, /^export .*CREDENTIALS.*FILE=/m)
    assert.doesNotMatch(envExample, /^export GOOGLE_DRIVE_ACCESS_TOKEN=/m)
    assert.doesNotMatch(envExample, /^export GOOGLE_CALENDAR_ACCESS_TOKEN=/m)
    assert.doesNotMatch(envExample, /^export OPENAI_API_KEY=/m)
  })
})
