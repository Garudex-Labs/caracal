// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal TUI entry point: bootstraps the AdminClient and launches the menu.

import { readFileSync } from 'node:fs'
import { parse } from 'smol-toml'
import { AdminClient } from '@caracalai/admin'
import { discoverAdminToken } from '@caracalai/core'
import {
  DEFAULT_API_URL,
  DEFAULT_COORDINATOR_URL,
  resolveCliConfigPath,
  resolveServiceUrl,
} from '@caracalai/core/cli'
import { App } from './screen.ts'
import { MenuView } from './views/menu.ts'

interface CliConfig { zone_id?: string }

function loadConfig(): CliConfig | undefined {
  const path = resolveCliConfigPath()
  if (!path) return undefined
  try { return parse(readFileSync(path, 'utf8')) as unknown as CliConfig } catch { return undefined }
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
  const apiUrl = resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)
  const coordinatorUrl = resolveServiceUrl('CARACAL_COORDINATOR_URL', DEFAULT_COORDINATOR_URL)
  const coordinatorToken = process.env.CARACAL_COORDINATOR_TOKEN
  const cfg = loadConfig()
  const zoneId = process.env.CARACAL_ZONE_ID ?? cfg?.zone_id

  const client = new AdminClient({ apiUrl, coordinatorUrl, adminToken, coordinatorToken })
  const menu = new MenuView(client, zoneId)
  const app = new App('Caracal TUI', () => {
    const zid = menu.currentZoneId()
    return `${apiUrl}${zid ? `  zone:${zid}` : ''}`
  })
  void app.run(menu)
}

main()
