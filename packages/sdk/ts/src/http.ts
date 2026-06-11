/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * HTTP server middleware that binds Caracal context after a verifier boundary.
 */

import { Caracal, type RootOptions } from './client.js'

export interface IncomingLike {
  headers: Record<string, string | string[] | undefined>
}

export type FastifyRequestLike = IncomingLike

export type ConnectMiddleware = (req: IncomingLike, res: unknown, next: (err?: unknown) => void) => void

export function caracalContextMiddleware(caracal: Caracal, opts: RootOptions = {}): ConnectMiddleware {
  return (req, _res, next) => {
    caracal
      .bindFromHeaders(
        req.headers,
        async () => {
          next()
        },
        opts,
      )
      .catch(next)
  }
}

export function caracalFastifyHook(caracal: Caracal, opts: RootOptions = {}) {
  return async (req: IncomingLike) => {
    await caracal.bindFromHeaders(req.headers, async () => undefined, opts)
  }
}
