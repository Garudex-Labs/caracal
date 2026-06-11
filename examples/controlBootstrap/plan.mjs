// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Desired state for the PiperNet reporter agent environment plus the drift checks and scope tiers the pipeline uses.

import { createHash } from 'node:crypto'
import { createControlClient } from './controlClient.mjs'

// The four objects every environment needs before the reporter agent can run.

export const AGENT = {
  name: 'PiperNet Reporter',
}

export const PROVIDER = {
  name: 'PiperNet Mandate',
  identifier: 'provider://pipernet-mandate',
  kind: 'caracal_mandate',
  config: {},
}

export const RESOURCE = {
  name: 'PiperNet',
  identifier: 'resource://pipernet',
  scopes: ['pipernet.read', 'pipernet.write'],
  upstreamUrl: 'https://api.pipernet.example',
}

export const POLICY = {
  name: 'PiperNet reporter baseline',
  description: 'Allow the PiperNet reporter agent to read PiperNet.',
  schemaVersion: 'v1',
  content: [
    'package caracal.authz',
    '',
    'default allow := false',
    '',
    'allow if {',
    '  input.resource == "resource://pipernet"',
    '  input.action == "read"',
    '}',
    '',
  ].join('\n'),
}

// Each pipeline stage requests only the scopes it needs, so each stage can run
// under its own control key: verify works with a read-only key.

const COMMANDS = ['app', 'identity-provider', 'resource', 'policy']

function scopeSet(verbs) {
  return COMMANDS.flatMap((command) => verbs.map((verb) => `control:${command}:${verb}`))
}

export const SCOPES = {
  apply: scopeSet(['read', 'write']),
  verify: scopeSet(['read']),
  teardown: scopeSet(['read', 'delete']),
}

export function loadConfig(scopes, env = process.env) {
  const requested = env.CONTROL_SCOPES && env.CONTROL_SCOPES.trim() !== ''
    ? env.CONTROL_SCOPES
    : scopes
  return {
    stsUrl: env.STS_URL ?? 'http://127.0.0.1:8080',
    controlUrl: env.CONTROL_URL ?? 'http://127.0.0.1:8087',
    audience: env.CONTROL_AUDIENCE ?? 'caracal-control',
    clientId: env.CONTROL_CLIENT_ID,
    clientSecret: env.CONTROL_CLIENT_SECRET,
    scopes: requested,
    ttlSeconds: env.CONTROL_TTL_SECONDS ? Number(env.CONTROL_TTL_SECONDS) : undefined,
  }
}

export function clientFromEnv(scopes, env = process.env, deps = {}) {
  return createControlClient(loadConfig(scopes, env), deps)
}

export function byIdentifier(items, identifier) {
  return Array.isArray(items) ? items.find((item) => item?.identifier === identifier) : undefined
}

export function byName(items, name) {
  return Array.isArray(items) ? items.find((item) => item?.name === name) : undefined
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// Drift checks compare a live object to the plan and return the field names
// that differ. An empty result means the object is in sync.

export function providerDrift(live) {
  const drift = []
  if (live.name !== PROVIDER.name) drift.push('name')
  if (live.kind !== PROVIDER.kind) drift.push('kind')
  return drift
}

export function resourceDrift(live, providerId) {
  const drift = []
  if (live.name !== RESOURCE.name) drift.push('name')
  if (!sameScopes(live.scopes, RESOURCE.scopes)) drift.push('scopes')
  if (live.upstream_url !== RESOURCE.upstreamUrl) drift.push('upstream_url')
  if (live.credential_provider_id !== providerId) drift.push('credential_provider_id')
  return drift
}

export function policyDrift(live) {
  const latest = latestVersion(live)
  return latest?.content_sha256 === sha256Hex(POLICY.content) ? [] : ['content']
}

function latestVersion(live) {
  const versions = Array.isArray(live?.versions) ? live.versions : []
  return versions.reduce((latest, version) => {
    return latest === undefined || version.version > latest.version ? version : latest
  }, undefined)
}

function sameScopes(live, desired) {
  if (!Array.isArray(live) || live.length !== desired.length) return false
  const have = new Set(live)
  return desired.every((scope) => have.has(scope))
}
