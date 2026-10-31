// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Real-stack governed agent contract: `caracal launch claude-code` against Coordinator, STS, Gateway, and Audit.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdminClient, authorGrantsDocument } from '../../../packages/admin/ts/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const apiUrl = process.env.CARACAL_API_URL ?? 'http://127.0.0.1:3000'
const coordinatorUrl = process.env.CARACAL_COORDINATOR_URL ?? 'http://127.0.0.1:4000'
const adminTokenFile = process.env.CARACAL_ADMIN_TOKEN_FILE
const coordinatorTokenFile = process.env.CARACAL_COORDINATOR_TOKEN_FILE
const network = process.env.CARACAL_E2E_NETWORK ?? 'caracalDevData'
const nodeImage = process.env.CARACAL_E2E_NODE_IMAGE ?? 'node:24-alpine'
const nodeBin = process.env.CARACAL_E2E_NODE_BIN ?? 'node'
const agentCommand = process.env.CARACAL_E2E_AGENT_COMMAND ?? 'claude'

if (!adminTokenFile) throw new Error('CARACAL_ADMIN_TOKEN_FILE is required')
if (!coordinatorTokenFile) throw new Error('CARACAL_COORDINATOR_TOKEN_FILE is required')
if (spawnSync(agentCommand, ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error(`agent command '${agentCommand}' is not runnable`)

const modelResource = 'resource://pipernet-models'
const toolsResource = 'resource://claude-code-tools'
const toolScopes = ['tool:Read', 'tool:Edit', 'tool:Bash', 'tool:WebFetch']
const suffix = `${Date.now()}-${process.pid}`
const injectedKey = `sk-gateway-e2e-${suffix}`
const admin = new AdminClient({ apiUrl, adminToken: readFileSync(adminTokenFile, 'utf8').trim() })
const operatorToken = readFileSync(coordinatorTokenFile, 'utf8').trim()
const work = mkdtempSync(join(tmpdir(), 'caracal-agent-launch-'))
const state = { policies: [], upstreams: [] }
const results = {}
const failures = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(name, ok, detail) {
  results[name] = { ok, ...detail }
  if (!ok) failures.push(name)
}

async function grantTools(scopes) {
  const policy = await admin.policies.create(state.zone.id, {
    name: `Anton tools ${state.policies.length + 1}: ${scopes.join(' ')}`,
    content: authorGrantsDocument([
      { applicationId: state.app.id, resourceIdentifier: modelResource, scopes: ['models:invoke'] },
      { applicationId: state.app.id, resourceIdentifier: toolsResource, scopes },
    ]),
  })
  state.policies.push(policy)
  const version = await admin.policySets.addVersion(state.zone.id, state.policySet.id, [{ policy_version_id: policy.version_id }])
  await admin.policySets.activate(state.zone.id, state.policySet.id, version.version_id)
  for (let i = 0; i < 60; i++) {
    if ((await admin.policySets.activationStatus(state.zone.id, state.policySet.id, version.version_id)).propagation_status === 'loaded') return
    await sleep(500)
  }
  throw new Error('policy activation timed out')
}

// Points the model Resource at a fresh scripted upstream that asks for one Bash call running `command`.
async function scriptModel(name, command) {
  const container = `caracal-agent-e2e-${name}-${process.pid}`
  const run = spawnSync('docker', [
    'run', '-d', '--rm', '--name', container, '--network', network,
    '-e', 'STUB_HOST=0.0.0.0', '-e', `STUB_EXPECT_KEY=${injectedKey}`, '-e', `STUB_COMMAND=${command}`,
    '-v', `${join(root, 'tests/shared/mocks')}:/mocks:ro`, '--entrypoint', nodeBin, nodeImage, '/mocks/agentModelUpstream.mjs', '18090',
  ], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`model upstream ${name} failed to start: ${run.stderr}`)
  state.upstreams.push(container)
  await admin.resources.patch(state.zone.id, state.model.id, { upstream_url: `http://${container}:18090` })
  await sleep(1500)
  return container
}

function upstreamRequests(container) {
  const out = spawnSync('docker', ['logs', container], { encoding: 'utf8' }).stdout
  return out.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
}

// Runs `caracal launch claude-code`; onSession receives the agent Session id once printed.
function launch(agentArgs, onSession) {
  const env = { ...process.env, CARACAL_ZONE_ID: state.zone.id, CARACAL_APPLICATION_ID: state.app.id, CARACAL_APP_CLIENT_SECRET: state.app.client_secret }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  const child = spawn(process.execPath, [join(root, 'apps/runtime/bin/caracal.mjs'), 'launch', 'claude-code', '--profile', state.profile, '--command', agentCommand, '--', ...agentArgs], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    const match = /claude-code Session (\S+)/.exec(stderr)
    if (match && onSession) {
      const notify = onSession
      onSession = undefined
      notify(match[1])
    }
  })
  child.stdout.resume()
  return new Promise((done) => child.on('exit', (code) => done({ code, stderr, session: /claude-code Session (\S+)/.exec(stderr)?.[1] })))
}

async function terminate(sessionId) {
  const res = await fetch(`${coordinatorUrl}/zones/${state.zone.id}/agents/${sessionId}?reason=agent-launch-e2e`, { method: 'DELETE', headers: { authorization: `Bearer ${operatorToken}` } })
  return res.status
}

const runStub = ['-p', 'run the stub task', '--allowedTools', 'Bash', '--output-format', 'json']

async function cleanup() {
  for (const container of state.upstreams) spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' })
  const steps = [
    () => state.policySet && admin.policySets.delete(state.zone.id, state.policySet.id),
    ...state.policies.map((policy) => () => admin.policies.delete(state.zone.id, policy.id)),
    () => state.tools && admin.resources.delete(state.zone.id, state.tools.id),
    () => state.model && admin.resources.delete(state.zone.id, state.model.id),
    () => state.toolsProvider && admin.providers.delete(state.zone.id, state.toolsProvider.id),
    () => state.modelProvider && admin.providers.delete(state.zone.id, state.modelProvider.id),
    () => state.app && admin.applications.delete(state.zone.id, state.app.id),
    () => state.zone && admin.zones.delete(state.zone.id),
  ]
  for (const step of steps) {
    try {
      await step()
    } catch (err) {
      console.warn(`cleanup step failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  rmSync(work, { recursive: true, force: true })
}

try {
  state.zone = await admin.zones.create({ name: 'Pied Piper Agent Launch E2E', slug: `pied-piper-agent-launch-${suffix}` })
  state.app = await admin.applications.create(state.zone.id, { name: 'Anton Agent Launch E2E', registration_method: 'managed' })
  state.modelProvider = await admin.providers.create(state.zone.id, {
    name: 'PiperNet Model Key',
    identifier: 'provider://pipernet-model-key',
    kind: 'api_key',
    config_json: { auth_location: 'header', header_name: 'x-api-key', api_key: injectedKey },
  })
  state.toolsProvider = await admin.providers.create(state.zone.id, { name: 'Agent Tools', identifier: 'provider://agent-tools-none', kind: 'none' })
  state.model = await admin.resources.create(state.zone.id, {
    name: 'PiperNet Models',
    identifier: modelResource,
    upstream_url: 'http://pipernet-models.invalid',
    credential_provider_id: state.modelProvider.id,
    scopes: ['models:invoke'],
    operation_enforcement: 'enforced',
    operations: [
      { method: 'HEAD', path: '/api/hello', scope: 'models:invoke' },
      { method: 'POST', path: '/v1/messages', scope: 'models:invoke' },
      { method: 'POST', path: '/v1/messages/count_tokens', scope: 'models:invoke' },
    ],
  })
  state.tools = await admin.resources.create(state.zone.id, {
    name: 'Claude Code Tools',
    identifier: toolsResource,
    upstream_url: 'https://agent-tools.invalid',
    credential_provider_id: state.toolsProvider.id,
    scopes: toolScopes,
    operation_enforcement: 'transport_uniform',
  })
  state.policySet = await admin.policySets.create(state.zone.id, 'Anton Agent Launch E2E')
  state.profile = join(work, 'anton.json')
  writeFileSync(state.profile, JSON.stringify({ model: { resource: modelResource, scopes: ['models:invoke'] }, tools: { resource: toolsResource, scopes: toolScopes } }))

  await grantTools(['tool:Read', 'tool:Bash'])

  const allowedMarker = join(work, 'allowed.marker')
  const allowedUpstream = await scriptModel('allowed', `touch ${allowedMarker}`)
  const allowed = await launch(runStub)
  const seen = upstreamRequests(allowedUpstream)
  check('granted tool runs and the upstream sees only the injected key', allowed.code === 0 && existsSync(allowedMarker) && seen.length > 0 && seen.every((r) => r.keyMatchesInjected === true), {
    exit: allowed.code,
    upstreamRequests: seen.length,
  })

  const envDump = join(work, 'env.txt')
  await scriptModel('env', `env > ${envDump}`)
  await launch(runStub)
  const dumped = existsSync(envDump) ? readFileSync(envDump, 'utf8') : ''
  check(
    'agent tools see no Caracal or provider credential',
    dumped !== '' && !dumped.includes(state.app.client_secret) && !dumped.includes(injectedKey) && !/^CARACAL_/m.test(dumped),
    { anthropicApiKey: /^ANTHROPIC_API_KEY=(.*)$/m.exec(dumped)?.[1] },
  )

  await grantTools(['tool:Read'])
  const deniedMarker = join(work, 'denied.marker')
  await scriptModel('denied', `touch ${deniedMarker}`)
  const denied = await launch(runStub)
  check('ungranted tool is denied before it runs', !existsSync(deniedMarker) && denied.stderr.includes('caracal: denied Bash'), { exit: denied.code })

  const settingsMarker = join(work, 'settings.marker')
  mkdirSync(join(work, '.claude'), { recursive: true })
  for (const file of ['settings.json', 'settings.local.json']) writeFileSync(join(work, '.claude', file), JSON.stringify({ disableAllHooks: true }))
  await scriptModel('settings', `touch ${settingsMarker}`)
  await launch(runStub)
  rmSync(join(work, '.claude'), { recursive: true, force: true })
  check('settings files written in the workspace cannot disable the hooks', !existsSync(settingsMarker), {})

  await grantTools(['tool:Read', 'tool:Bash'])
  const killedMarker = join(work, 'killed.marker')
  const grandchildPid = join(work, 'killed.pid')
  await scriptModel('killed', `sh -c 'sleep 30 & echo $! > ${grandchildPid}; wait; touch ${killedMarker}'`)
  let terminatedAt = 0
  let deleteStatus
  const killed = await launch(runStub, (id) =>
    setTimeout(async () => {
      terminatedAt = Date.now()
      deleteStatus = await terminate(id)
    }, 4000),
  )
  const stoppedAfterMs = Date.now() - terminatedAt
  await sleep(1000)
  const grandchild = Number(readFileSync(grandchildPid, 'utf8'))
  let grandchildAlive = true
  try {
    process.kill(grandchild, 0)
  } catch {
    grandchildAlive = false
  }
  check('terminating the agent Session stops the agent and its subprocesses', deleteStatus === 204 && killed.code === 143 && !existsSync(killedMarker) && !grandchildAlive && stoppedAfterMs < 10_000, {
    exit: killed.code,
    stoppedAfterMs,
  })

  await scriptModel('concurrent', `sh -c 'sleep 8; touch ${work}/concurrent-$$.marker'`)
  const [stopped, survivor] = await Promise.all([launch(runStub, (id) => setTimeout(() => void terminate(id), 3000)), launch(runStub)])
  const concurrentMarkers = readdirSync(work).filter((name) => name.startsWith('concurrent-')).length
  check('concurrent launches run in separate Sessions and stop independently', stopped.code === 143 && survivor.code === 0 && concurrentMarkers === 1 && stopped.session !== survivor.session, {
    stoppedExit: stopped.code,
    survivorExit: survivor.code,
  })

  const bare = await launch(['--bare', '-p', 'hi'])
  check('flags that disable hooks are refused', bare.code === 1 && bare.stderr.includes('--bare is not allowed'), {})

  await sleep(3000)
  const events = await admin.audit.list(state.zone.id, { limit: 500 })
  const toolDecisions = events.filter((e) => e.event_type === 'token_exchange' && e.metadata_json?.resource === toolsResource)
  check('tool decisions are audited', toolDecisions.some((e) => e.decision === 'allow') && toolDecisions.some((e) => e.decision === 'deny'), {
    allow: toolDecisions.filter((e) => e.decision === 'allow').length,
    deny: toolDecisions.filter((e) => e.decision === 'deny').length,
  })
} finally {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, results }, null, 1))
  await cleanup()
}
if (failures.length) process.exit(1)
