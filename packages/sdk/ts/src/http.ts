/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Generic HTTP server middleware: extracts the wire envelope from incoming requests
 * and binds a CaracalContext for the handler scope. Works with Express, Connect,
 * Fastify (via preHandler), and any framework exposing (req, res, next).
 */

import { Caracal } from "./client.js";

export interface IncomingLike {
  headers: Record<string, string | string[] | undefined>;
}

export type ConnectMiddleware = (
  req: IncomingLike,
  res: unknown,
  next: (err?: unknown) => void,
) => void;

export function caracalHttpMiddleware(caracal: Caracal): ConnectMiddleware {
  return (req, _res, next) => {
    caracal
      .bindFromHeaders(req.headers, async () => {
        next();
      })
      .catch(next);
  };
}

export interface FastifyRequestLike {
  headers: Record<string, string | string[] | undefined>;
}

export function caracalFastifyHook(caracal: Caracal) {
  return async (req: FastifyRequestLike) => {
    await caracal.bindFromHeaders(req.headers, async () => undefined);
  };
}
