/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Route middleware that isolates sidebars and pagination by documentation version.
 */

import { defineRouteMiddleware } from '@astrojs/starlight/route-data'
import { docsRouteVersion } from '../../versioning.mjs'

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute
  const version = docsRouteVersion(`/${route.entry.id}/`)
  const group = route.sidebar.find((item) => item.label === version && 'entries' in item)

  if (group && 'entries' in group) route.sidebar = group.entries
  route.pagination.prev = matchingVersion(route.pagination.prev, version)
  route.pagination.next = matchingVersion(route.pagination.next, version)
})

function matchingVersion(link, version) {
  if (!link) return undefined
  return docsRouteVersion(new URL(link.href, 'https://docs.caracal.run').pathname) === version ? link : undefined
}
