// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal server-to-server bridge.
 *
 * The registry API owns application authorization but delegates
 * every identity mutation to Better Auth. These endpoints are the thin
 * seam: they authenticate with a shared secret, are never routed by the
 * public load balancer, and only call Better Auth APIs - no auth logic of
 * their own.
 */

import { timingSafeEqual } from "node:crypto";
import type { Auth } from "./auth.js";
import { ROLES } from "./auth.js";
import { env } from "./env.js";

function secretMatches(header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(env.internalSecret);
  const provided = Buffer.from(header);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** POST /internal/set-role - mirror a role change decided by the registry API. */
async function setRole(auth: Auth, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const userId = body?.userId;
  const role = body?.role;
  if (typeof userId !== "string" || typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
    return Response.json({ error: "userId and a valid role are required" }, { status: 422 });
  }
  const ctx = await auth.$context;
  const updated = await ctx.internalAdapter.updateUser(userId, { role });
  if (!updated) {
    return Response.json({ error: "user not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}

/** POST /internal/revoke-sessions - revoke every session for a user (deactivation). */
async function revokeSessions(auth: Auth, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const userId = body?.userId;
  if (typeof userId !== "string") {
    return Response.json({ error: "userId is required" }, { status: 422 });
  }
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteSessions([userId]);
  return Response.json({ ok: true });
}

const INTERNAL_ROUTES: Record<string, (auth: Auth, request: Request) => Promise<Response>> = {
  "/internal/set-role": setRole,
  "/internal/revoke-sessions": revokeSessions,
};

export async function handleInternal(auth: Auth, pathname: string, request: Request): Promise<Response | null> {
  const handler = INTERNAL_ROUTES[pathname];
  if (!handler) return null;
  if (!secretMatches(request.headers.get("x-internal-secret"))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  return handler(auth, request);
}
