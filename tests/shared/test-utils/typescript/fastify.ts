// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared Fastify route test helpers for TypeScript suites.

import Fastify from 'fastify'
import { vi } from 'vitest'
import type { FastifyPluginAsync } from 'fastify'

interface RouteOptions {
  prefix?: string
}

interface BuildRouteAppExtras {
  actor?: unknown
}

export function buildRouteApp(
  route: FastifyPluginAsync,
  options: RouteOptions = { prefix: '/v1' },
  extras: BuildRouteAppExtras = {},
) {
  const app = Fastify({ logger: false })
  const db = {
    query: vi.fn(),
    connect: vi.fn(),
  }
  const redis = {
    incr: vi.fn(),
    expire: vi.fn(),
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    call: vi.fn(),
    xadd: vi.fn(),
  }
  app.decorate('db', db as never)
  app.decorate('redis', redis as never)
  if (extras.actor !== undefined) {
    app.addHook('preHandler', async (req) => {
      ;(req as unknown as { actor: unknown }).actor = extras.actor
    })
  }
  app.register(route, options)
  return { app, db, redis }
}
