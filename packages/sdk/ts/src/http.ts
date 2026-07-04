/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * HTTP server middleware that binds Caracal context after a verifier boundary.
 */

import type { Caracal, BindOptions } from './client.js'

export interface IncomingLike {
  headers: Record<string, string | string[] | undefined>
}

export type FastifyRequestLike = IncomingLike

export interface ServerResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

export interface FastifyReplyLike {
  code(statusCode: number): FastifyReplyLike
  header(name: string, value: string): FastifyReplyLike
  send(payload?: string): unknown
}

export type ConnectMiddleware = (req: IncomingLike, res: ServerResponseLike, next: (err?: unknown) => void) => void

const REJECT_BODY = '{"error":"unauthorized","error_description":"invalid or missing authorization"}'

export function caracalContextMiddleware(caracal: Caracal, opts: BindOptions = {}): ConnectMiddleware {
  return caracal.contextMiddleware(opts)
}

export function caracalFastifyHook(caracal: Caracal, opts: BindOptions = {}) {
  return (req: FastifyRequestLike, reply: FastifyReplyLike, done: (err?: unknown) => void): void => {
    let entered = false
    caracal
      .bindFromHeaders(
        req.headers,
        async () => {
          entered = true
          done()
        },
        opts,
      )
      .catch((err) => {
        if (entered) {
          done(err)
          return
        }
        reply.code(401).header('content-type', 'application/json').send(REJECT_BODY)
      })
  }
}
