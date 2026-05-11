// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal init`: provisions the local zone via the API and writes caracal.toml.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { discoverAdminToken } from '@caracalai/core'
import { AdminClient, AdminApiError, type LocalBootstrapResult } from '@caracalai/admin'
import { showHelp } from './shared.ts'

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

function nextArg(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) {
    process.stderr.write(`Error: ${flag} requires a value\n`)
    process.exit(1)
  }
  return v
}

function initHelp(): never {
  return showHelp(
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
    ],
  )
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
  process.stdout.write(
    'Note: Caracal enforces policy only on traffic that reaches the gateway or a Caracal connector.\n' +
      '      Direct calls to the host or to provider APIs bypass Caracal. Firewall every path that\n' +
      '      is not fronted by the gateway/connector in production.\n',
  )
}
