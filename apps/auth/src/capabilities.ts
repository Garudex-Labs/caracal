// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * The single authoritative description of which sign-in methods this
 * deployment actually supports. Every consumer (login UI, Go config
 * routes, CLI) reads this; nothing else re-derives provider availability.
 *
 * A method is advertised only when it is genuinely usable:
 * environment-derived methods need their credentials present, and
 * registration-derived methods (enterprise SSO, passkeys) need at least
 * one live registration. Hiding a method here is presentation only -
 * Better Auth itself still rejects unconfigured providers.
 */

import type { Pool } from "pg";

export type AuthCapabilities = {
  email_password: boolean;
  magic_links: boolean;
  google: boolean;
  github: boolean;
  sso: boolean;
  passkeys: boolean;
  dev_login: boolean;
};

export type CapabilityInputs = {
  /** Development logs mail to the console; production needs the webhook. */
  emailDelivery: boolean;
  google: boolean;
  github: boolean;
  devLogin: boolean;
  /** Registered enterprise identity providers; -1 when the probe failed. */
  ssoProviders: number;
  /** Registered passkey credentials; -1 when the probe failed. */
  passkeys: number;
};

// Registering a new provider means adding its rule here and its wire flag
// to AuthCapabilities; consumers pick it up from the descriptor.
export function computeCapabilities(inputs: CapabilityInputs): AuthCapabilities {
  return {
    email_password: true,
    magic_links: inputs.emailDelivery,
    google: inputs.google,
    github: inputs.github,
    // Unknown registration state fails closed: a method is never
    // advertised on the strength of a failed probe.
    sso: inputs.ssoProviders > 0,
    passkeys: inputs.passkeys > 0,
    dev_login: inputs.devLogin,
  };
}

const PROBE_TTL_MS = 30_000;
const PROBE_FAILURE_TTL_MS = 5_000;

let cached: { value: AuthCapabilities; expires: number } | null = null;

/** Test hook: drop the registration-probe cache. */
export function resetCapabilityCache(): void {
  cached = null;
}

async function probeRegistrations(pool: Pool): Promise<{ ssoProviders: number; passkeys: number }> {
  const result = await pool.query(
    'SELECT (SELECT count(*) FROM "ssoProvider") AS sso, (SELECT count(*) FROM "passkey") AS passkeys',
  );
  const row = result.rows[0] ?? {};
  return { ssoProviders: Number(row.sso ?? 0), passkeys: Number(row.passkeys ?? 0) };
}

/** Environment-derived capability inputs; the entrypoint supplies them. */
export type EnvironmentInputs = Omit<CapabilityInputs, "ssoProviders" | "passkeys">;

export async function getCapabilities(pool: Pool, environment: EnvironmentInputs): Promise<AuthCapabilities> {
  const now = Date.now();
  if (cached && now < cached.expires) {
    return cached.value;
  }
  let registrations = { ssoProviders: -1, passkeys: -1 };
  let ttl = PROBE_FAILURE_TTL_MS;
  try {
    registrations = await probeRegistrations(pool);
    ttl = PROBE_TTL_MS;
  } catch (error) {
    console.error("[auth-service] capability probe failed:", error);
  }
  const value = computeCapabilities({ ...environment, ...registrations });
  cached = { value, expires: now + ttl };
  return value;
}
