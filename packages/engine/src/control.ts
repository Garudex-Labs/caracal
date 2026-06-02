// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control API credential lifecycle helpers for least-privilege Control API keys.

import type { AdminClient, Application, Resource } from '@caracalai/admin'
import { generateClientSecret } from './clientSecret.js'
import { describeRemoteSurface } from './dispatch.js'

export const CONTROL_INVOKE_TRAIT = 'control:invoke'
export const DEFAULT_CONTROL_AUDIENCE = 'caracal-control'
export const CONTROL_SCOPE_TRAIT_PREFIX = 'control:scope:'
export const CONTROL_MAX_TTL_TRAIT_PREFIX = 'control:max-ttl:'
export const CONTROL_EXPIRES_TRAIT_PREFIX = 'control:expires:'

export type ControlAction = 'read' | 'write' | 'delete'

export interface ControlPermission {
  command: string
  subcommand: string
  action: ControlAction
  scope: string
}

export interface ControlKeyCreateInput {
  name: string
  audience?: string
  scopes?: string[]
  actions?: ControlAction[]
  resources?: string[]
  maxTtlSeconds?: number
  expiresAt?: string
}

export interface ControlKeyCreateResult {
  name: string
  clientId: string
  clientSecret: string
  resource: Resource
  allowedScopes: string[]
  maxTtlSeconds?: number
  expiresAt?: string
}

export interface ControlKeyRotateResult {
  clientId: string
  clientSecret: string
}

export interface ControlKeyRecord {
  name: string
  client_id: string
  allowed_scopes: string[]
  max_ttl_seconds?: number
  expires_at?: string
  restrictions: string[]
  created_at: string
}

function hasControlTrait(app: Application): boolean {
  return Array.isArray(app.traits) && app.traits.includes(CONTROL_INVOKE_TRAIT)
}

export function controlScopes(): string[] {
  return [...new Set(describeRemoteSurface().map((row) => row.scope))].sort()
}

export function controlPermissions(): ControlPermission[] {
  return describeRemoteSurface()
    .map((row) => ({
      command: row.command,
      subcommand: row.subcommand,
      action: scopeAction(row.scope),
      scope: row.scope,
    }))
    .sort((left, right) => left.scope.localeCompare(right.scope))
}

export function controlKeyRecord(app: Application): ControlKeyRecord {
  const traits = app.traits ?? []
  return {
    name: app.name,
    client_id: app.id,
    allowed_scopes: controlScopeTraits(traits),
    max_ttl_seconds: controlMaxTtlTrait(traits),
    expires_at: controlExpiresTrait(traits),
    restrictions: ['zone-bound', 'application-only', 'no-subject-token', 'no-delegation'],
    created_at: app.created_at,
  }
}

export async function ensureControlResource(
  client: AdminClient,
  zoneId: string,
  audience = process.env.CONTROL_AUDIENCE ?? DEFAULT_CONTROL_AUDIENCE,
): Promise<Resource> {
  const scopes = controlScopes()
  const resources = await client.resources.list(zoneId, { controlResource: true })
  const current = resources.find((resource) => resource.identifier === audience)
  if (!current) {
    return client.resources.create(zoneId, {
      name: 'Control API',
      identifier: audience,
      scopes,
    }, { controlResource: true })
  }
  const currentScopes = [...current.scopes].sort()
  if (scopes.length === currentScopes.length && scopes.every((scope, index) => scope === currentScopes[index])) {
    return current
  }
  return client.resources.patch(zoneId, current.id, { scopes }, { controlResource: true })
}

export async function controlKeyList(client: AdminClient, zoneId: string): Promise<ControlKeyRecord[]> {
  const apps = await client.applications.list(zoneId, { applicationInternals: true })
  return apps.filter(hasControlTrait).map(controlKeyRecord)
}

async function requireControlApplication(client: AdminClient, zoneId: string, id: string): Promise<Application> {
  const app = await client.applications.get(zoneId, id, { applicationInternals: true })
  if (!hasControlTrait(app)) {
    throw new Error(`application ${id} is not a control API key (missing trait ${CONTROL_INVOKE_TRAIT})`)
  }
  return app
}

export async function controlKeyGet(client: AdminClient, zoneId: string, id: string): Promise<ControlKeyRecord> {
  return controlKeyRecord(await requireControlApplication(client, zoneId, id))
}

export async function controlKeyCreate(
  client: AdminClient,
  zoneId: string,
  input: ControlKeyCreateInput,
): Promise<ControlKeyCreateResult> {
  const allowedScopes = resolveAllowedScopes(input)
  const maxTtlSeconds = validateMaxTtl(input.maxTtlSeconds)
  const expiresAt = validateExpiresAt(input.expiresAt)
  const resource = await ensureControlResource(client, zoneId, input.audience)
  const application = await client.applications.create(zoneId, {
    name: input.name,
    registration_method: 'managed',
    traits: [
      CONTROL_INVOKE_TRAIT,
      ...allowedScopes.map((scope) => `${CONTROL_SCOPE_TRAIT_PREFIX}${scope}`),
      ...(maxTtlSeconds ? [`${CONTROL_MAX_TTL_TRAIT_PREFIX}${maxTtlSeconds}`] : []),
      ...(expiresAt ? [`${CONTROL_EXPIRES_TRAIT_PREFIX}${expiresAt}`] : []),
    ],
  })
  const clientSecret = application.client_secret
  if (!clientSecret) throw new Error('application response did not include the one-time client secret')
  return { name: application.name, clientId: application.id, clientSecret, resource, allowedScopes, maxTtlSeconds, expiresAt }
}

export async function controlKeyRotate(
  client: AdminClient,
  zoneId: string,
  id: string,
): Promise<ControlKeyRotateResult> {
  await requireControlApplication(client, zoneId, id)
  await ensureControlResource(client, zoneId)
  const clientSecret = generateClientSecret()
  const application = await client.applications.patch(zoneId, id, { client_secret: clientSecret })
  return { clientId: application.id, clientSecret }
}

export async function controlKeyRevoke(client: AdminClient, zoneId: string, id: string): Promise<void> {
  await requireControlApplication(client, zoneId, id)
  await client.applications.delete(zoneId, id)
}

function scopeAction(scope: string): ControlAction {
  const action = scope.split(':').at(-1)
  if (action === 'read' || action === 'write' || action === 'delete') return action
  throw new Error(`unsupported control scope action: ${scope}`)
}

function controlScopeTraits(traits: readonly string[]): string[] {
  const valid = new Set(controlScopes())
  return [...new Set(traits
    .filter((trait) => trait.startsWith(CONTROL_SCOPE_TRAIT_PREFIX))
    .map((trait) => trait.slice(CONTROL_SCOPE_TRAIT_PREFIX.length))
    .filter((scope) => valid.has(scope)))]
    .sort()
}

function controlMaxTtlTrait(traits: readonly string[]): number | undefined {
  const trait = traits.find((value) => value.startsWith(CONTROL_MAX_TTL_TRAIT_PREFIX))
  if (!trait) return undefined
  const value = Number.parseInt(trait.slice(CONTROL_MAX_TTL_TRAIT_PREFIX.length), 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function controlExpiresTrait(traits: readonly string[]): string | undefined {
  const trait = traits.find((value) => value.startsWith(CONTROL_EXPIRES_TRAIT_PREFIX))
  if (!trait) return undefined
  const value = trait.slice(CONTROL_EXPIRES_TRAIT_PREFIX.length)
  return Number.isFinite(Date.parse(value)) ? value : undefined
}

function resolveAllowedScopes(input: ControlKeyCreateInput): string[] {
  const available = new Set(controlScopes())
  const requested = new Set<string>()
  for (const scope of input.scopes ?? []) requested.add(scope)

  const actions = new Set(input.actions ?? [])
  const resources = new Set(input.resources ?? [])
  if (actions.size > 0 || resources.size > 0) {
    for (const permission of controlPermissions()) {
      const actionMatch = actions.size === 0 || actions.has(permission.action)
      const resourceMatch = resources.size === 0 || resources.has(permission.command)
      if (actionMatch && resourceMatch) requested.add(permission.scope)
    }
  }

  const scopes = [...requested].map((scope) => scope.trim()).filter((scope) => scope.length > 0)
  if (scopes.length === 0) {
    throw new Error('control key permissions are required; choose explicit scopes, actions, or resources')
  }
  for (const scope of scopes) {
    if (!available.has(scope)) throw new Error(`unsupported control scope: ${scope}`)
  }
  return [...new Set(scopes)].sort()
}

function validateMaxTtl(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 60 || value > 900) {
    throw new Error('control key max token TTL must be between 60 and 900 seconds')
  }
  return value
}

function validateExpiresAt(value: string | undefined): string | undefined {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('control key expiry must be an ISO timestamp')
  if (timestamp <= Date.now()) throw new Error('control key expiry must be in the future')
  return new Date(timestamp).toISOString()
}
