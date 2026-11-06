#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Exercise a disposable Compose stack, never an existing operator project.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback)
const mode = option('--mode', 'source')
assert(['source', 'runtime'].includes(mode), '--mode must be source or runtime')
const profile = option('--profile', mode === 'runtime' ? 'stable' : 'dev')
assert(['dev', 'rc', 'stable'].includes(profile), '--profile must be dev, rc, or stable')
const source = resolve(option('--source', root))
const reportPath = resolve(option('--report', join(root, '.caracal/deployment-verification.json')))
const work = mkdtempSync(join(tmpdir(), 'caracal-verify-'))
const project = `caracal-verify-${process.pid}`
const file = join(work, 'compose.json')
// Shell interpreters read incrementally; freeze scripts for this verification.
for (const name of ['backup', 'restore'])
  writeFileSync(join(work, `${name}.sh`), readFileSync(join(root, `infra/scripts/${name}.sh`)), { mode: 0o600 })
const metrics = { mode, profile, source, project, startedAt: new Date().toISOString(), checks: [], images: {} }
// Keep build/transport settings, not an operator's cloud credentials or service
// overrides. Verification must never contact their configured secret backend.
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|HOME|USER|LOGNAME|TMPDIR|LANG|LC_.*|DOCKER_.*|BUILDX_.*|BUILDKIT_.*|GOTOOLCHAIN|GOCACHE|GOPATH|PNPM_HOME|CI|NO_COLOR|GITHUB_ACTIONS|ACTIONS_.*|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE)$/.test(
      key,
    ),
  ),
)
const env = {
  ...inherited,
  CARACAL_SECRETS_DIR: join(work, 'secrets'),
  CARACAL_DEV_VERSION: option('--image-tag', `verify-${process.pid}`),
  CARACAL_VERSION: JSON.parse(readFileSync(join(source, 'release.config.json'), 'utf8')).product.version,
  CARACAL_MODE: profile,
  CARACAL_PRIVATE_EGRESS_HOSTS: 'verification-upstream',
  CARACAL_PASSWORD_SIGNUP: 'false',
  GITHUB_CLIENT_ID: 'disposable-test',
  GITHUB_CLIENT_SECRET: 'disposable-test',
}
const endpoint =
  process.env.DOCKER_HOST ??
  spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).stdout?.trim()
assert(
  endpoint && /^(unix:\/\/|npipe:\/\/)/.test(endpoint),
  'verification requires a local Docker daemon, never a remote deployment context',
)
const { bootstrapSecrets } = await import(pathToFileURL(join(root, 'packages/engine/dist/index.js')))
bootstrapSecrets({ secretsDir: env.CARACAL_SECRETS_DIR })

function run(command, argv, { capture = false, allowFailure = false, extraEnv = {}, timeout = 900_000 } = {}) {
  const result = spawnSync(command, argv, {
    cwd: root,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    timeout,
  })
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${argv.join(' ')} failed (${result.status}): ${result.error ?? result.stderr ?? ''}`)
  }
  return result
}
const compose = (argv, options) => run('docker', ['compose', '-p', project, '-f', file, ...argv], options)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const container = (service) => compose(['ps', '--all', '-q', service], { capture: true }).stdout.trim()
async function status(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(8000) })).status
  } catch {
    return 0
  }
}
async function waitFor(check, label, seconds = 120) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await check()) {
      metrics.checks.push(label)
      console.log(`ok: ${label}`)
      return
    }
    await sleep(1000)
  }
  throw new Error(`timed out: ${label}`)
}
function port(service, target) {
  const address = compose(['port', service, String(target)], { capture: true }).stdout.trim()
  assert.match(address, /^127\.0\.0\.1:\d+$/)
  return `http://${address}`
}

try {
  const devFile = join(source, 'infra/docker/docker-compose.yml')
  const dev = JSON.parse(run('docker', ['compose', '-f', devFile, 'config', '--format', 'json'], { capture: true }).stdout)
  if (!args.includes('--skip-build')) {
    const start = Date.now()
    // Build shared images once and preserve BuildKit caches between CI runners.
    for (const name of ['postgres', 'redis', 'sts', 'api', 'web']) {
      const service = dev.services[name]
      const build = service.build
      const cache =
        process.env.GITHUB_ACTIONS === 'true'
          ? ['--cache-from', `type=gha,scope=deployment-${name}`, '--cache-to', `type=gha,mode=max,scope=deployment-${name}`]
          : []
      run('docker', [
        'buildx',
        'build',
        build.context,
        '--file',
        resolve(build.context, build.dockerfile ?? 'Dockerfile'),
        '--tag',
        service.image,
        '--load',
        ...cache,
      ])
    }
    metrics.buildSeconds = (Date.now() - start) / 1000
  }
  const config =
    mode === 'source'
      ? dev
      : JSON.parse(
          run('docker', ['compose', '-f', join(source, 'infra/docker/runtime-compose.yml'), 'config', '--format', 'json'], {
            capture: true,
          }).stdout,
        )
  config.name = project
  config.networks = { caracalData: { name: `${project}-data`, driver: 'bridge' } }
  for (const volume of Object.values(config.volumes)) delete volume.name
  for (const [name, service] of Object.entries(config.services)) {
    delete service.build
    delete service.container_name
    if (dev.services[name].image) service.image = dev.services[name].image
    for (const mount of service.volumes ?? []) {
      if (mount.type === 'bind' && mount.target === '/run/caracal-control') {
        mount.source = join(work, 'control')
        mkdirSync(mount.source, { recursive: true })
      }
    }
    for (const mapping of service.ports ?? []) {
      mapping.host_ip = '127.0.0.1'
      mapping.published = '0'
    }
    if (service.healthcheck) {
      service.healthcheck.interval = '1s'
      service.healthcheck.retries = 10
    }
  }
  config.services['verification-upstream'] = {
    image: dev.services.replayVolumeInit.image,
    networks: ['caracalData'],
    entrypoint: ['sh', '-c', 'mkdir -p /tmp/www; echo verified > /tmp/www/index.html; exec httpd -f -p 8080 -h /tmp/www'],
    user: '65532:65532',
    read_only: true,
    tmpfs: ['/tmp'],
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
  }
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 })

  const badFile = join(work, 'missing-secret.json')
  const badProject = `${project}-negative`
  const badConfig = structuredClone(config)
  badConfig.secrets.redisPassword.file = join(work, 'missing-redis-password')
  writeFileSync(badFile, JSON.stringify(badConfig), { mode: 0o600 })
  try {
    const missing = run('docker', ['compose', '-p', badProject, '-f', badFile, 'run', '--rm', '--no-deps', 'redis'], {
      capture: true,
      allowFailure: true,
      timeout: 30_000,
    })
    assert(missing.status !== 0 && missing.status !== null, 'missing secret must fail before startup')
  } finally {
    run('docker', ['compose', '-p', badProject, '-f', badFile, 'down', '-v'], { capture: true, allowFailure: true })
  }
  const unauthenticatedRedis = run(
    'docker',
    ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/run/caracal:mode=1777', dev.services.redis.image],
    { capture: true, allowFailure: true, timeout: 30_000 },
  )
  assert.equal(unauthenticatedRedis.status, 1, 'Redis must not start without a password')
  assert.match(unauthenticatedRedis.stderr, /required/)
  metrics.checks.push('missing Compose secret and unauthenticated Redis fail closed')

  const start = Date.now()
  compose(['up', '-d', '--wait', '--wait-timeout', '240', '--pull', 'missing'])
  metrics.startupSeconds = (Date.now() - start) / 1000
  const urls = Object.fromEntries(
    Object.entries({ api: 3000, coordinator: 4000, sts: 8080, gateway: 8081, audit: 9090, web: 3002 }).map(([name, target]) => [
      name,
      port(name, target),
    ]),
  )
  for (const [name, url] of Object.entries(urls)) await waitFor(async () => (await status(`${url}/ready`)) === 200, `${name} readiness`)
  assert.equal(await status(`${urls.web}/`), 200, 'packaged SPA')
  assert.equal(await status(`${urls.web}/api/console/zones`), 401, 'console must reject anonymous access')
  assert([401, 403].includes(await status(`${urls.api}/v1/zones`)), 'API must reject anonymous administration')
  metrics.checks.push('SPA and anonymous authorization boundaries')
  const contractEnv = {
    CARACAL_API_URL: urls.api,
    CARACAL_COORDINATOR_URL: urls.coordinator,
    CARACAL_STS_URL: urls.sts,
    CARACAL_GATEWAY_URL: urls.gateway,
    CARACAL_E2E_UPSTREAM_URL: 'http://verification-upstream:8080',
    CARACAL_ADMIN_TOKEN_FILE: join(env.CARACAL_SECRETS_DIR, 'caracalAdminToken'),
  }
  const { AdminClient } = await import(pathToFileURL(join(root, 'packages/admin/ts/dist/index.js')))
  const admin = new AdminClient({ apiUrl: urls.api, adminToken: readFileSync(contractEnv.CARACAL_ADMIN_TOKEN_FILE, 'utf8').trim() })
  const sentinel = await admin.zones.create({ name: 'Deployment recovery sentinel', slug: `verify-sentinel-${process.pid}` })
  const contract = () => run('node', ['tests/typescript/e2e/protected-resource.mjs'], { extraEnv: contractEnv, timeout: 120_000 })
  contract()
  metrics.checks.push('SDK -> Coordinator -> STS -> Gateway -> protected upstream -> Audit')
  if (args.includes('--go-contracts')) {
    run('go', ['test', '-count=1', './tests/go/e2e/...', './tests/go/smoke/...'], { extraEnv: contractEnv })
    metrics.checks.push('live Go exchange and HMAC contracts')
  }
  metrics.stats = run('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...Object.keys(urls).map(container)], { capture: true })
    .stdout.trim()
    .split('\n')
    .map(JSON.parse)
  for (const image of new Set(Object.values(dev.services).map((s) => s.image))) {
    const [data] = JSON.parse(run('docker', ['image', 'inspect', image], { capture: true }).stdout)
    metrics.images[image] = { bytes: data.Size, user: data.Config.User }
  }

  // Stopping a store must change readiness, not merely leave green liveness.
  compose(['stop', 'postgres'])
  await waitFor(async () => (await status(`${urls.web}/ready`)) === 503, 'web rejects traffic without Postgres')
  assert.equal(await status(`${urls.web}/health`), 200, 'dependency failure must not fail process liveness')
  await waitFor(
    () => {
      const [data] = JSON.parse(run('docker', ['inspect', container('web')], { capture: true }).stdout)
      return data.State.Health.Status === 'unhealthy'
    },
    'web container health follows readiness',
    45,
  )
  compose(['start', 'postgres'])
  for (const [name, url] of Object.entries(urls))
    await waitFor(async () => (await status(`${url}/ready`)) === 200, `${name} recovers after Postgres restart`)
  compose(['stop', 'redis'])
  await waitFor(async () => (await status(`${urls.sts}/ready`)) === 503, 'STS rejects traffic without Redis')
  compose(['start', 'redis'])
  await waitFor(async () => (await status(`${urls.sts}/ready`)) === 200, 'STS recovers after Redis restart')
  compose(['restart', 'sts', 'gateway', 'api', 'coordinator', 'audit', 'web'])
  for (const [name, target] of Object.entries({ api: 3000, coordinator: 4000, sts: 8080, gateway: 8081, audit: 9090, web: 3002 }))
    urls[name] = port(name, target)
  Object.assign(contractEnv, {
    CARACAL_API_URL: urls.api,
    CARACAL_COORDINATOR_URL: urls.coordinator,
    CARACAL_STS_URL: urls.sts,
    CARACAL_GATEWAY_URL: urls.gateway,
  })
  for (const [name, url] of Object.entries(urls))
    await waitFor(async () => (await status(`${url}/ready`)) === 200, `${name} recovers after app restart`)
  // Re-run the real distributed contract after failures, not only probes.
  contract()
  compose(['run', '--rm', '--no-deps', 'dbMigrate'])
  metrics.checks.push('idempotent migration rerun')
  compose(['up', '-d', '--wait', '--wait-timeout', '180', '--force-recreate', '--pull', 'missing'])
  for (const [name, target] of Object.entries({ api: 3000, coordinator: 4000, sts: 8080, gateway: 8081, audit: 9090, web: 3002 }))
    urls[name] = port(name, target)
  Object.assign(contractEnv, {
    CARACAL_API_URL: urls.api,
    CARACAL_COORDINATOR_URL: urls.coordinator,
    CARACAL_STS_URL: urls.sts,
    CARACAL_GATEWAY_URL: urls.gateway,
  })
  contract()
  const recoveredAdmin = new AdminClient({
    apiUrl: urls.api,
    adminToken: readFileSync(contractEnv.CARACAL_ADMIN_TOKEN_FILE, 'utf8').trim(),
  })
  assert.equal((await recoveredAdmin.zones.get(sentinel.id)).id, sentinel.id)
  metrics.checks.push('same-version upgrade preserves application data')
  const backupDir = join(work, 'backups')
  run('sh', [join(work, 'backup.sh')], { extraEnv: { CARACAL_COMPOSE_PROJECT: project, CARACAL_BACKUP_DIR: backupDir } })
  const archive = join(
    backupDir,
    readdirSync(backupDir).find((name) => name.endsWith('.tar.gz')),
  )
  assert.equal(statSync(archive).mode & 0o777, 0o600, 'backup contains credential hashes and must be private')
  await recoveredAdmin.zones.delete(sentinel.id)
  run('sh', [join(work, 'restore.sh'), archive], { extraEnv: { CARACAL_COMPOSE_PROJECT: project, CARACAL_RESTORE_CONFIRM: 'yes' } })
  for (const [name, target] of Object.entries({ api: 3000, coordinator: 4000, sts: 8080, gateway: 8081, audit: 9090, web: 3002 }))
    urls[name] = port(name, target)
  Object.assign(contractEnv, {
    CARACAL_API_URL: urls.api,
    CARACAL_COORDINATOR_URL: urls.coordinator,
    CARACAL_STS_URL: urls.sts,
    CARACAL_GATEWAY_URL: urls.gateway,
  })
  for (const [name, url] of Object.entries(urls))
    await waitFor(async () => (await status(`${url}/ready`)) === 200, `${name} ready after restore`)
  const restoredAdmin = new AdminClient({ apiUrl: urls.api, adminToken: readFileSync(contractEnv.CARACAL_ADMIN_TOKEN_FILE, 'utf8').trim() })
  assert.equal((await restoredAdmin.zones.get(sentinel.id)).id, sentinel.id)
  contract()
  metrics.checks.push('private backup, restore recovers deleted application data and distributed contract')
  const stop = Date.now()
  compose(['stop', 'sts', 'gateway', 'api', 'coordinator', 'audit', 'web'])
  metrics.shutdownSeconds = (Date.now() - stop) / 1000
  for (const name of Object.keys(urls)) {
    const [data] = JSON.parse(run('docker', ['inspect', container(name)], { capture: true }).stdout)
    assert.notEqual(data.State.ExitCode, 137, `${name} exceeded graceful shutdown deadline`)
    assert.equal(data.State.OOMKilled, false)
  }
  metrics.checks.push('graceful shutdown without SIGKILL or OOM')
  metrics.ok = true
} catch (error) {
  metrics.ok = false
  metrics.error = error.message
  console.error(error)
  if (readFileSafe(file)) {
    compose(['ps', '--all'], { allowFailure: true })
    let logs = compose(['logs', '--tail', '60', '--no-color'], { capture: true, allowFailure: true }).stdout ?? ''
    for (const secret of readdirSync(env.CARACAL_SECRETS_DIR)) {
      const value = readFileSafe(join(env.CARACAL_SECRETS_DIR, secret))?.toString().trim()
      if (value) logs = logs.split(value).join('[REDACTED]')
    }
    metrics.diagnostics = logs
  }
  process.exitCode = 1
} finally {
  if (readFileSafe(file)) compose(['down', '-v', '--remove-orphans'], { allowFailure: true })
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(metrics, null, 2) + '\n', { mode: 0o600 })
  rmSync(work, { recursive: true, force: true })
  console.log(`Verification report: ${reportPath}`)
}

function readFileSafe(path) {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}
