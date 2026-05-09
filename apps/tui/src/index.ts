// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal TUI entry point: bootstraps the AdminClient and launches the menu.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { AdminClient } from '@caracalai/admin'
import { discoverAdminToken } from '@caracalai/core'
import { App } from './screen.ts'
import { MenuView } from './views/menu.ts'

interface CliConfig { zone_id?: string }

function loadConfig(): CliConfig | undefined {
  const candidates: string[] = []
  if (process.env.CARACAL_CONFIG) candidates.push(process.env.CARACAL_CONFIG)
  for (const dir of [process.cwd(), process.env.PWD, process.env.INIT_CWD]) {
    if (dir) candidates.push(join(dir, 'caracal.toml'))
  }
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), '.config')
  candidates.push(join(xdg, 'caracal', 'caracal.toml'))
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try { return parse(readFileSync(p, 'utf8')) as unknown as CliConfig } catch { /* Try the next config candidate. */ }
  }
  return undefined
}

function main(): void {
  if (!process.stdin.isTTY) {
    process.stderr.write('caracal-tui: stdin is not a TTY — run from an interactive terminal.\n')
    process.exit(1)
  }
  const adminToken = discoverAdminToken()
  if (!adminToken) {
    process.stderr.write('caracal-tui: CARACAL_ADMIN_TOKEN not set; export it or add it to infra/docker/.env\n')
    process.exit(1)
  }
  const apiUrl = resolveServiceUrl('CARACAL_API_URL', 'http://localhost:3000')
  const coordinatorUrl = resolveServiceUrl('CARACAL_COORDINATOR_URL', 'http://localhost:4000')
  const coordinatorToken = process.env.CARACAL_COORDINATOR_TOKEN
  const cfg = loadConfig()
  const zoneId = process.env.CARACAL_ZONE_ID ?? cfg?.zone_id

  const client = new AdminClient({ apiUrl, coordinatorUrl, adminToken, coordinatorToken })
  const app = new App('Caracal TUI', `${apiUrl}${zoneId ? `  zone:${zoneId}` : ''}`)
  void app.run(new MenuView(client, zoneId))
}

function resolveServiceUrl(envKey: string, devDefault: string): string {
  const v = process.env[envKey]
  if (v) return v
  const env = process.env.NODE_ENV ?? 'development'
  if (env !== 'development') {
    process.stderr.write(`caracal-tui: ${envKey} is required when NODE_ENV=${env}\n`)
    process.exit(1)
  }
  return devDefault
}

main()
