// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verb bodies for `caracal zone …` admin commands.

import type { AdminClient, Zone, ZoneInput } from '@caracalai/admin'

export interface ZoneListOpts {
  client: AdminClient
}

export interface ZoneIdOpts {
  client: AdminClient
  id: string
}

export interface ZoneCreateOpts {
  client: AdminClient
  input: ZoneInput
}

export interface ZonePatchOpts {
  client: AdminClient
  id: string
  input: Partial<ZoneInput>
}

export function zoneList(opts: ZoneListOpts): Promise<Zone[]> {
  return opts.client.zones.list()
}

export function zoneGet(opts: ZoneIdOpts): Promise<Zone> {
  return opts.client.zones.get(opts.id)
}

export function zoneCreate(opts: ZoneCreateOpts): Promise<Zone> {
  return opts.client.zones.create(opts.input)
}

export function zonePatch(opts: ZonePatchOpts): Promise<Zone> {
  return opts.client.zones.patch(opts.id, opts.input)
}

export function zoneDelete(opts: ZoneIdOpts): Promise<void> {
  return opts.client.zones.delete(opts.id)
}
