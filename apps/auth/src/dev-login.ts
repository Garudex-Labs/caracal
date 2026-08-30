// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Development sign-in provider.
 *
 * A real authentication method for local development: it provisions and
 * signs in the fixed dev identity through Better Auth's ordinary user,
 * account, and session machinery, so the account behaves like any other
 * account downstream (JWTs, organizations, permissions, logout).
 *
 * The method exists only in an unambiguously local development
 * environment. `devLoginPermitted` is the single authority for that
 * decision and every gate goes through it: the capability descriptor
 * (env.ts), route registration (index.ts), and the handler itself, which
 * re-reads the process environment so a wiring mistake elsewhere cannot
 * expose the method. Nothing request-derived (host, headers, body) can
 * influence the decision.
 *
 * The account carries no static secret: a fresh random password is
 * generated on every login and immediately rotated in, so even a database
 * later promoted to production holds no publicly known credential.
 */

import { randomBytes } from "node:crypto";
import type { Auth } from "./auth.js";

/** Fixed local development identity; the TLD cannot receive real mail. */
export const DEV_USER = {
  email: "dev@localhost.caracal",
  name: "Dev User",
} as const;

/** Hostnames that prove the configured public URL is this machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Server-controlled inputs to the environment decision. */
export type DevLoginEnvironment = {
  nodeEnv: string | undefined;
  devLoginFlag: string | undefined;
  baseURL: string | undefined;
};

/**
 * True only when all three server-side conditions hold: NODE_ENV is
 * exactly "development" (not merely non-production, so unset, test, and
 * staging environments fail), AUTH_DEV_LOGIN=1 is an explicit opt-in, and
 * the deployment's configured public URL is a loopback host, which no
 * reachable production deployment can be.
 */
export function devLoginPermitted(environment: DevLoginEnvironment): boolean {
  if (environment.nodeEnv !== "development") return false;
  if (environment.devLoginFlag !== "1") return false;
  if (!environment.baseURL) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(environment.baseURL).hostname);
  } catch {
    return false;
  }
}

/** The decision against the live process environment, never the request. */
function permittedNow(): boolean {
  return devLoginPermitted({
    nodeEnv: process.env.NODE_ENV,
    devLoginFlag: process.env.AUTH_DEV_LOGIN,
    baseURL: process.env.BETTER_AUTH_URL,
  });
}

export async function handleDevLogin(auth: Auth, request: Request): Promise<Response> {
  if (!permittedNow()) {
    // Indistinguishable from a route that was never registered.
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  // One-time credential for this login only; rotated before every sign-in.
  const password = randomBytes(24).toString("base64url");
  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(DEV_USER.email);
  if (!existing) {
    // First use: the normal sign-up path creates the user, credential
    // account, and session in one step (no email verification in dev).
    return auth.api.signUpEmail({
      body: { email: DEV_USER.email, password, name: DEV_USER.name },
      headers: request.headers,
      asResponse: true,
    });
  }
  await ctx.internalAdapter.updatePassword(existing.user.id, await ctx.password.hash(password));
  return auth.api.signInEmail({
    body: { email: DEV_USER.email, password },
    headers: request.headers,
    asResponse: true,
  });
}
