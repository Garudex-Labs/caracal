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

  it('fails closed before network access when no credentials are injected', async () => {
    const { code, stderr } = await runNode([AGENT, 'task'])
    assert.equal(code, 2)
    assert.match(stderr, /missing GOOGLE_DRIVE_ACCESS_TOKEN/)
    assert.match(stderr, /missing GOOGLE_CALENDAR_ACCESS_TOKEN/)
    assert.match(stderr, /missing OPENAI_API_KEY/)
    assert.match(stderr, /caracal run/)
  })

  it('reports only the credentials that are absent', async () => {
    const { code, stderr } = await runNode([AGENT, 'task'], {
      GOOGLE_DRIVE_ACCESS_TOKEN: 'ya29.real-drive-token',
    })
    assert.equal(code, 2)
    assert.doesNotMatch(stderr, /missing GOOGLE_DRIVE_ACCESS_TOKEN/)
    assert.match(stderr, /missing GOOGLE_CALENDAR_ACCESS_TOKEN/)
    assert.match(stderr, /missing OPENAI_API_KEY/)
  })

  it('confirms injected credentials at startup without printing their values', async () => {
    const { code, stdout } = await runNode([AGENT], {
      GOOGLE_DRIVE_ACCESS_TOKEN: 'ya29.secret-drive-value',
      GOOGLE_CALENDAR_ACCESS_TOKEN: 'ya29.secret-calendar-value',
      OPENAI_API_KEY: 'sk-secret-openai-value',
    })
    assert.equal(code, 0)
    assert.match(stdout, /credential preflight/)
    assert.match(stdout, /GOOGLE_DRIVE_ACCESS_TOKEN\s+present/)
    assert.match(stdout, /GOOGLE_CALENDAR_ACCESS_TOKEN\s+present/)
    assert.match(stdout, /OPENAI_API_KEY\s+present/)
    assert.doesNotMatch(stdout, /secret-drive-value|secret-calendar-value|secret-openai-value/)
  })

  it('documents real providers and resource mappings', async () => {
    const readme = await readFile(README, 'utf8')
    assert.ok(readme.includes('https://www.googleapis.com'))
    assert.ok(readme.includes('https://api.openai.com/v1'))
    assert.match(readme, /resource:\/\/google-drive/)
    assert.match(readme, /resource:\/\/google-calendar/)
    assert.match(readme, /resource:\/\/openai/)
    assert.match(readme, /allow_runtime_injection = true/)
    assert.match(readme, /CARACAL_CONFIG/)
    assert.match(readme, /runtime\/<zone_id>\/<application_id>/)
    assert.match(readme, /CARACAL_RUN_TTL_SECONDS/)
    assert.match(readme, /GPT-5\.4 mini/)
    assert.match(readme, /drive\.readonly/)
    assert.match(readme, /calendar\.readonly/)
    assert.match(readme, /credential_type = "provider_token"/)
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
