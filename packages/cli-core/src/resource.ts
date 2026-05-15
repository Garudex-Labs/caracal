// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verb bodies for `caracal resource …` admin commands.

import type { AdminClient, Resource, ResourceInput } from '@caracalai/admin'

export interface ResourceListOpts { client: AdminClient; zoneId: string }
export interface ResourceIdOpts { client: AdminClient; zoneId: string; id: string }
export interface ResourceCreateOpts { client: AdminClient; zoneId: string; input: ResourceInput }
export interface ResourcePatchOpts { client: AdminClient; zoneId: string; id: string; input: Partial<ResourceInput> }

export function resourceList(opts: ResourceListOpts): Promise<Resource[]> {
  return opts.client.resources.list(opts.zoneId)
}

export function resourceGet(opts: ResourceIdOpts): Promise<Resource> {
  return opts.client.resources.get(opts.zoneId, opts.id)
}

export function resourceCreate(opts: ResourceCreateOpts): Promise<Resource> {
  return opts.client.resources.create(opts.zoneId, opts.input)
}

export function resourcePatch(opts: ResourcePatchOpts): Promise<Resource> {
  return opts.client.resources.patch(opts.zoneId, opts.id, opts.input)
}

export function resourceDelete(opts: ResourceIdOpts): Promise<void> {
  return opts.client.resources.delete(opts.zoneId, opts.id)
}
