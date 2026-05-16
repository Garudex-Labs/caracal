// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal control token|revoke`: mint or revoke an STS token scoped for the agent control surface.

import { OAuthClient } from '@caracalai/oauth'
import type { CliConfig } from '../config.ts'
import { fail, parseArgs, showHelp, unknownVerb, usage } from './shared.ts'
import { style, printSuccess, printInfo } from '../style.ts'

const HELP = `Usage: caracal-cli control <token|revoke> [options]

Commands:
  token    Mint an STS token with scope=control:invoke for an external agent
  revoke   Revoke a previously issued control token by its JTI

Options for token:
  --resource <url>    Control surface URL (default: $CARACAL_CONTROL_URL or http://localhost:8087)
  --ttl <seconds>     Requested token lifetime (default: 3600)
  --json              Emit JSON instead of human output

Options for revoke:
  --jti <id>          Token identifier to revoke (required)
`

export async function controlCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const verb = argv[0]
  if (!verb || verb === '--help' || verb === '-h') {
    showHelp(HELP)
    return
  }
  if (verb === 'token') return tokenVerb(argv.slice(1), cfg)
  if (verb === 'revoke') return revokeVerb(argv.slice(1), cfg)
  unknownVerb('control', verb)
}

async function tokenVerb(argv: string[], cfg?: CliConfig): Promise<void> {
  if (!cfg) fail('control token requires caracal.toml (zone, app, secret)')
  const { flags } = parseArgs(argv)
  const resource = (flags.resource as string | undefined) ?? process.env.CARACAL_CONTROL_URL ?? 'http://localhost:8087'
  const ttl = flags.ttl ? Number(flags.ttl) : 3600
  if (!Number.isFinite(ttl) || ttl <= 0) fail('--ttl must be a positive integer')

  const client = new OAuthClient(cfg!.zone_url, cfg!.zone_id, cfg!.application_id)
  const token = await client.exchange(cfg!.app_client_secret, resource, {
    clientSecret: cfg!.app_client_secret,
    scopes: ['control:invoke'],
    ttlSeconds: ttl,
  })

  if (flags.json) {
    process.stdout.write(JSON.stringify({ access_token: token.access_token, expires_in: token.expires_in, resource }, null, 2) + '\n')
    return
  }
  printSuccess('Control token issued')
  process.stdout.write(`\n${style.label('Resource:  ')}${resource}\n`)
  process.stdout.write(`${style.label('Expires in:')} ${token.expires_in}s\n`)
  process.stdout.write(`${style.label('Token:     ')}${style.code(token.access_token)}\n\n`)
  printInfo('Paste the token into your agent or workflow as a Bearer credential.')
  printInfo(`Test: curl -sH "Authorization: Bearer $TOKEN" -d '{"command":"zone","subcommand":"list"}' ${resource}/v1/agent/invoke`)
}

async function revokeVerb(argv: string[], cfg?: CliConfig): Promise<void> {
  if (!cfg) fail('control revoke requires caracal.toml')
  const { flags } = parseArgs(argv)
  const jti = flags.jti as string | undefined
  if (!jti) usage('control revoke', '--jti <id>')
  const url = `${cfg!.zone_url}/v1/revocations`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${cfg!.application_id}:${cfg!.app_client_secret}`).toString('base64')}` },
    body: JSON.stringify({ jti, reason: 'control_token_revoke' }),
  })
  if (!res.ok) fail(`revoke failed: ${res.status} ${await res.text()}`)
  printSuccess(`Revoked token jti=${jti}`)
}
