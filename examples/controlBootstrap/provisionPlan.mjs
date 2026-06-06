// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared definition of the demo zone objects and the control client configuration both bootstrap and teardown consume.

import { createControlClient } from './controlClient.mjs'

export const PROVIDER = {
  name: 'PiperNet Mandate',
  identifier: 'pipernet-mandate',
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
  name: 'PiperNet baseline',
  description: 'Allow PiperNet read for Pied Piper operators.',
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

const BOOTSTRAP_SCOPES = [
  'control:identity-provider:read',
  'control:identity-provider:write',
  'control:identity-provider:delete',
  'control:resource:read',
  'control:resource:write',
  'control:resource:delete',
  'control:policy:read',
  'control:policy:write',
  'control:policy:delete',
]

export function loadConfig(env = process.env) {
  const scopes = env.CONTROL_SCOPES && env.CONTROL_SCOPES.trim() !== ''
    ? env.CONTROL_SCOPES
    : BOOTSTRAP_SCOPES
  return {
    stsUrl: env.STS_URL,
    controlUrl: env.CONTROL_URL,
    audience: env.CONTROL_AUDIENCE ?? 'caracal-control',
    clientId: env.CONTROL_CLIENT_ID,
    clientSecret: env.CONTROL_CLIENT_SECRET,
    scopes,
    ttlSeconds: env.CONTROL_TTL_SECONDS ? Number(env.CONTROL_TTL_SECONDS) : undefined,
  }
}

export function clientFromEnv(env = process.env, deps = {}) {
  return createControlClient(loadConfig(env), deps)
}

export function findByIdentifier(items, identifier) {
  return Array.isArray(items) ? items.find((item) => item?.identifier === identifier) : undefined
}

export function findByName(items, name) {
  return Array.isArray(items) ? items.find((item) => item?.name === name) : undefined
}
