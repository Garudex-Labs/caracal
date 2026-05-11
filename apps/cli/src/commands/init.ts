// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal init`: provisions the local zone via the API and writes caracal.toml.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { discoverAdminToken } from '@caracalai/core'
import { AdminClient, AdminApiError, type LocalBootstrapResult } from '@caracalai/admin'

interface InitOptions {
  apiUrl: string
  adminToken: string
  configPath: string
  zoneUrl: string
  force: boolean
}

const DEFAULT_API_URL = 'http://localhost:3000'
const DEFAULT_ZONE_URL = 'http://localhost:8080'

function defaultConfigPath(): string {
  for (const dir of [process.cwd(), process.env.PWD, process.env.INIT_CWD]) {
    if (!dir) continue
    const path = join(dir, 'caracal.toml')
    if (existsSync(path)) return path
  }
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(base, 'caracal', 'caracal.toml')
}

function envFilePath(): string | undefined {
  const candidates = [
    process.env.CARACAL_ENV_FILE,
    join(process.cwd(), 'infra', 'docker', '.env'),
    join(process.cwd(), '.env'),
  ].filter((p): p is string => Boolean(p))
  return candidates.find((p) => existsSync(p))
}

function upsertEnvVar(path: string, key: string, value: string): boolean {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const re = new RegExp(`^${escapeRegex(key)}=.*$`, 'm')
  const line = `${key}=${value}`
  if (re.test(text)) {
    const next = text.replace(re, line)
    if (next === text) return false
    writeFileSync(path, next, { mode: 0o600 })
    return true
  }
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n'
  writeFileSync(path, `${text}${sep}${line}\n`, { mode: 0o600 })
  return true
}

function mergeResourceBinding(path: string, resource: string, applicationId: string): boolean {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const re = /^RESOURCE_APPLICATION_BINDINGS=(.*)$/m
  const match = re.exec(text)
  const existing = match ? match[1]!.split(',').map((s) => s.trim()).filter(Boolean) : []
  const next = existing.filter((entry) => !entry.startsWith(`${resource}=`))
  next.push(`${resource}=${applicationId}`)
  return upsertEnvVar(path, 'RESOURCE_APPLICATION_BINDINGS', next.join(','))
}

function nextArg(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) {
    process.stderr.write(`Error: ${flag} requires a value\n`)
    process.exit(1)
  }
  return v
}

function initHelp(): never {
  process.stdout.write(
    [
      'Usage: caracal init [options]',
      '',
      'Provisions the local zone via POST /v1/local/bootstrap and writes caracal.toml.',
      '',
      'Flags:',
      '  --api-url <url>        Caracal API URL (default: http://localhost:3000)',
      '  --zone-url <url>       STS/zone base URL (default: http://localhost:8080)',
      '  --admin-token <t>      CARACAL_ADMIN_TOKEN override',
      '  --config <path>        Output path for caracal.toml',
      '  --force                Rotate the client secret if the zone exists',
      '  --help, -h             Show this help',
      '',
    ].join('\n'),
  )
  process.exit(0)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseFlags(argv: string[]): InitOptions {
  let apiUrl = process.env.CARACAL_API_URL ?? DEFAULT_API_URL
  let zoneUrl = process.env.CARACAL_ZONE_URL ?? DEFAULT_ZONE_URL
  let configPath = process.env.CARACAL_CONFIG ?? defaultConfigPath()
  let adminToken: string | undefined
  let force = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '--api-url':
        apiUrl = nextArg(argv, i, arg); i++; break
      case '--zone-url':
        zoneUrl = nextArg(argv, i, arg); i++; break
      case '--admin-token':
        adminToken = nextArg(argv, i, arg); i++; break
      case '--config':
        configPath = nextArg(argv, i, arg); i++; break
      case '--force':
        force = true
        break
      case '--help':
      case '-h':
        initHelp()
      default:
        process.stderr.write(`Unknown flag: ${arg}\n`)
        process.exit(1)
    }
  }

  const token = discoverAdminToken(adminToken)
  if (!token) {
    process.stderr.write(
      'Error: CARACAL_ADMIN_TOKEN not set; pass --admin-token, set the env var, or add it to infra/docker/.env\n',
    )
    process.exit(1)
  }
  return { apiUrl, zoneUrl, configPath, adminToken: token, force }
}

function renderToml(opts: { zoneUrl: string; zoneId: string; applicationId: string; clientSecret: string; resource: string }): string {
  return [
    `zone_url = "${opts.zoneUrl}"`,
    `zone_id = "${opts.zoneId}"`,
    `application_id = "${opts.applicationId}"`,
    `app_client_secret = "${opts.clientSecret}"`,
    '',
    '[[credentials]]',
    'env = "RESOURCE_TOKEN"',
    `resource = "${opts.resource}"`,
    '',
    '[mcp_governance]',
    'mode = "block"',
    '',
  ].join('\n')
}

export async function initCommand(argv: string[]): Promise<void> {
  const opts = parseFlags(argv)

  const client = new AdminClient({ apiUrl: opts.apiUrl, adminToken: opts.adminToken })
  let data: LocalBootstrapResult
  try {
    data = await client.bootstrap(opts.force)
  } catch (err) {
    if (err instanceof AdminApiError) {
      process.stderr.write(`Error: bootstrap failed (${err.status}): ${err.code}\n`)
    } else {
      const desc = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: cannot reach Caracal API at ${opts.apiUrl}: ${desc}\n`)
    }
    process.exit(1)
  }

  const envPath = envFilePath()
  if (envPath) {
    if (mergeResourceBinding(envPath, data.resource, data.application_id)) {
      process.stdout.write(
        `Updated RESOURCE_APPLICATION_BINDINGS in ${envPath}; restart the gateway with \`caracal up\` to apply.\n`,
      )
    }
  }

  if (!data.app_client_secret) {
    if (existsSync(opts.configPath)) {
      process.stdout.write(
        `Zone already provisioned; existing config at ${opts.configPath} left in place. Re-run with --force to rotate the client secret.\n`,
      )
      return
    }
    process.stderr.write(
      'Error: zone already provisioned but no local config exists; re-run with --force to rotate the client secret.\n',
    )
    process.exit(1)
  }

  const toml = renderToml({
    zoneUrl: opts.zoneUrl,
    zoneId: data.zone_id,
    applicationId: data.application_id,
    clientSecret: data.app_client_secret,
    resource: data.resource,
  })

  mkdirSync(dirname(opts.configPath), { recursive: true })
  writeFileSync(opts.configPath, toml, { mode: 0o600 })
  process.stdout.write(`Wrote ${opts.configPath}\n`)
}
