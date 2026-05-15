// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal init`: provisions the local zone via the API and writes caracal.toml.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverAdminToken, runtimeEnvFile } from '@caracalai/core'
import { AdminApiError } from '@caracalai/admin'
import { stackInit } from '@caracalai/cli-core'
import { showHelp } from './shared.ts'
import { style, printError, printInfo, printSuccess, printWarn } from '../style.ts'

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
    printError(`${flag} requires a value`)
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
        printError(`unknown flag: ${arg}`)
        process.exit(1)
    }
  }

  const token = discoverAdminToken(adminToken)
  if (!token) {
    printError(`CARACAL_ADMIN_TOKEN not set; pass --admin-token, set the env var, or run \`caracal up\` (writes ${runtimeEnvFile()})`)
    process.exit(1)
  }
  return { apiUrl, zoneUrl, configPath, adminToken: token, force }
}

export async function initCommand(argv: string[]): Promise<void> {
  const opts = parseFlags(argv)

  try {
    const outcome = await stackInit({
      apiUrl: opts.apiUrl,
      adminToken: opts.adminToken,
      zoneUrl: opts.zoneUrl,
      configPath: opts.configPath,
      force: opts.force,
    })
    if (outcome.status === 'exists') {
      printInfo(`Zone already provisioned; existing config at ${outcome.configPath} left in place. Re-run with --force to rotate the client secret.`)
      return
    }
    printSuccess(`Wrote ${style.code(outcome.configPath)}`)
    printWarn(
      'Caracal enforces policy only on traffic that reaches the gateway or a Caracal connector.\n' +
        '  Direct calls to the host or to provider APIs bypass Caracal. Firewall every path that is\n' +
        '  not fronted by the gateway/connector in production.',
    )
  } catch (err) {
    if (err instanceof AdminApiError) {
      printError(`bootstrap failed (${err.status}): ${err.code}`)
    } else {
      const desc = err instanceof Error ? err.message : String(err)
      printError(desc.startsWith('zone already provisioned')
        ? desc
        : `cannot reach Caracal API at ${opts.apiUrl}: ${desc}`)
    }
    process.exit(1)
  }
}
