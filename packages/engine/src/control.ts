// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control API credential lifecycle helpers: list, create, rotate, and revoke OAuth apps with the `control:invoke` trait.

import { randomBytes } from 'node:crypto'
import type { AdminClient, Application } from '@caracalai/admin'

export const CONTROL_INVOKE_TRAIT = 'control:invoke'

export interface ControlKeyCreateInput {
  name: string
  clientSecret?: string
}

export interface ControlKeyCreateResult {
  application: Application
  clientSecret: string
}

export interface ControlKeyRotateResult {
  application: Application
  clientSecret: string
}

function generateClientSecret(): string {
  return `cs_${randomBytes(32).toString('base64url')}`
}

function hasControlTrait(app: Application): boolean {
  return Array.isArray(app.traits) && app.traits.includes(CONTROL_INVOKE_TRAIT)
}

export async function controlKeyList(client: AdminClient, zoneId: string): Promise<Application[]> {
  const apps = await client.applications.list(zoneId)
  return apps.filter(hasControlTrait)
}

export async function controlKeyGet(client: AdminClient, zoneId: string, id: string): Promise<Application> {
  const app = await client.applications.get(zoneId, id)
  if (!hasControlTrait(app)) {
    throw new Error(`application ${id} is not a control API key (missing trait ${CONTROL_INVOKE_TRAIT})`)
  }
  return app
}

export async function controlKeyCreate(
  client: AdminClient,
  zoneId: string,
  input: ControlKeyCreateInput,
): Promise<ControlKeyCreateResult> {
  const clientSecret = input.clientSecret ?? generateClientSecret()
  const application = await client.applications.create(zoneId, {
    name: input.name,
    registration_method: 'managed',
    credential_type: 'token',
    client_secret: clientSecret,
    traits: [CONTROL_INVOKE_TRAIT],
    consent: false,
  })
  return { application, clientSecret }
}

export async function controlKeyRotate(
  client: AdminClient,
  zoneId: string,
  id: string,
): Promise<ControlKeyRotateResult> {
  await controlKeyGet(client, zoneId, id)
  const clientSecret = generateClientSecret()
  const application = await client.applications.patch(zoneId, id, { client_secret: clientSecret })
  return { application, clientSecret }
}

export async function controlKeyRevoke(client: AdminClient, zoneId: string, id: string): Promise<void> {
  await controlKeyGet(client, zoneId, id)
  await client.applications.delete(zoneId, id)
}
