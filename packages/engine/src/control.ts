// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control API credential lifecycle helpers for least-privilege Control API keys.

import { ensureResource, type AdminClient, type Application, type Resource } from '@caracalai/admin'
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

export interface ControlKeyRecord {
  name: string
  client_id: string
  allowed_scopes: string[]
  max_ttl_seconds?: number
  expires_at?: string
  restrictions: string[]
  created_at: string
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
  return ensureResource(client, zoneId, { name: 'Control API', identifier: audience, scopes: controlScopes() })
}

function scopeAction(scope: string): ControlAction {
  const action = scope.split(':').at(-1)
  if (action === 'read' || action === 'write' || action === 'delete') return action
  throw new Error(`unsupported control scope action: ${scope}`)
}

function controlScopeTraits(traits: readonly string[]): string[] {
  const valid = new Set(controlScopes())
  return [
    ...new Set(
      traits
        .filter((trait) => trait.startsWith(CONTROL_SCOPE_TRAIT_PREFIX))
        .map((trait) => trait.slice(CONTROL_SCOPE_TRAIT_PREFIX.length))
        .filter((scope) => valid.has(scope)),
    ),
  ].sort()
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
