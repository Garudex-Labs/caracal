// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal init`: provisions the local zone via the API and writes caracal.toml.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

interface BootstrapResponse {
  zone_id: string
  app_id: string
  app_client_id: string
  app_client_secret: string | null
  resource: string
  scope: string
  rotated: boolean
}

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

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let value = m[2]!
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[m[1]!] = value
  }
  return out
}

function discoverAdminToken(explicit?: string): string | undefined {
  if (explicit) return explicit
  if (process.env.CARACAL_ADMIN_TOKEN) return process.env.CARACAL_ADMIN_TOKEN
  const candidates = [
    process.env.CARACAL_ENV_FILE,
    join(process.cwd(), 'infra', 'docker', '.env'),
    join(process.cwd(), '.env'),
  ].filter((p): p is string => Boolean(p))
  for (const path of candidates) {
    const env = readEnvFile(path)
    if (env.CARACAL_ADMIN_TOKEN) return env.CARACAL_ADMIN_TOKEN
  }
  return undefined
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
        apiUrl = argv[++i] ?? apiUrl
        break
      case '--zone-url':
        zoneUrl = argv[++i] ?? zoneUrl
        break
      case '--admin-token':
        adminToken = argv[++i]
        break
      case '--config':
        configPath = argv[++i] ?? configPath
        break
      case '--force':
        force = true
        break
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

function renderToml(opts: { zoneUrl: string; zoneId: string; clientId: string; clientSecret: string; resource: string }): string {
  return [
    `zone_url = "${opts.zoneUrl}"`,
    `zone_id = "${opts.zoneId}"`,
    `app_client_id = "${opts.clientId}"`,
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

  const url = `${opts.apiUrl.replace(/\/$/, '')}/v1/local/bootstrap`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ force: opts.force }),
    })
  } catch (err) {
    const desc = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: cannot reach Caracal API at ${opts.apiUrl}: ${desc}\n`)
    process.exit(1)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    process.stderr.write(`Error: bootstrap failed (${res.status}): ${body}\n`)
    process.exit(1)
  }

  const data = (await res.json()) as BootstrapResponse

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
    clientId: data.app_client_id,
    clientSecret: data.app_client_secret,
    resource: data.resource,
  })

  mkdirSync(dirname(opts.configPath), { recursive: true })
  writeFileSync(opts.configPath, toml, { mode: 0o600 })
  process.stdout.write(`Wrote ${opts.configPath}\n`)
}
