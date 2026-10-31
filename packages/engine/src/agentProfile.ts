// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Launch profile naming the Resources that carry a governed agent's model traffic and tool decisions.

import { readFileSync } from 'node:fs'
import { RuntimeConfigValidationError } from './runtimeConfig.js'

// A slice of one Resource the launcher delegates to the agent Session.
export interface AgentGrant {
  resource: string
  scopes: string[]
}

export interface AgentProfile {
  // Model API the agent talks to; the Gateway injects the provider credential.
  model: AgentGrant
  // Tool Resource whose scopes (`tool:<name>`) gate each agent tool call.
  tools: AgentGrant
  // Role labels the zone's grant policy matches; defaults to the application id.
  labels?: string[]
}

const PROFILE_KEYS = new Set(['model', 'tools', 'labels'])
const GRANT_KEYS = new Set(['resource', 'scopes'])

function token(source: string, field: string, value: unknown): string {
  // Scopes travel space-separated on the wire, so whitespace would split one value into many.
  if (typeof value !== 'string' || value === '' || /\s/.test(value)) {
    throw new RuntimeConfigValidationError(source, `${field} must be a non-empty string without whitespace`)
  }
  return value
}

function grant(source: string, field: string, value: unknown): AgentGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeConfigValidationError(source, `${field} must be an object`)
  const entry = value as Record<string, unknown>
  const unknown = Object.keys(entry).filter((key) => !GRANT_KEYS.has(key))
  if (unknown.length) throw new RuntimeConfigValidationError(source, `${field} has unsupported keys: ${unknown.join(', ')}`)
  if (!Array.isArray(entry.scopes) || entry.scopes.length === 0)
    throw new RuntimeConfigValidationError(source, `${field}.scopes must be a non-empty array`)
  return {
    resource: token(source, `${field}.resource`, entry.resource),
    scopes: entry.scopes.map((scope, i) => token(source, `${field}.scopes[${i}]`, scope)),
  }
}

export function parseAgentProfile(source: string, raw: string): AgentProfile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RuntimeConfigValidationError(source, 'profile must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new RuntimeConfigValidationError(source, 'profile must be a JSON object')
  const body = parsed as Record<string, unknown>
  const unknown = Object.keys(body).filter((key) => !PROFILE_KEYS.has(key))
  if (unknown.length) throw new RuntimeConfigValidationError(source, `unsupported keys: ${unknown.join(', ')}`)
  const profile: AgentProfile = { model: grant(source, 'model', body.model), tools: grant(source, 'tools', body.tools) }
  if (profile.model.resource === profile.tools.resource)
    throw new RuntimeConfigValidationError(source, 'model and tools must name different Resources')
  if (body.labels !== undefined) {
    if (!Array.isArray(body.labels)) throw new RuntimeConfigValidationError(source, 'labels must be an array')
    profile.labels = body.labels.map((label, i) => token(source, `labels[${i}]`, label))
  }
  return profile
}

export function readAgentProfile(path: string): AgentProfile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new RuntimeConfigValidationError(path, `cannot read profile: ${err instanceof Error ? err.message : String(err)}`)
  }
  return parseAgentProfile(path, raw)
}
