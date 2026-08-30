// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time environment for the identity service.
 *
 * Everything the service needs is validated here, once, before Better Auth
 * is constructed. Secrets support the `NAME_FILE` convention used by the
 * rest of the Caracal stack (value read from a mounted secret file).
 */

import { readFileSync } from "node:fs";
import { devLoginPermitted } from "./dev-login.js";

export type Env = {
  /** true only when NODE_ENV is exactly "production" */
  isProduction: boolean;
  port: number;
  /** Public base URL of this service as browsers reach it, e.g. https://caracal.example.com */
  baseURL: string;
  /** Path Better Auth is mounted under (nginx routes this prefix here). */
  basePath: string;
  databaseUrl: string;
  secret: string;
  trustedOrigins: string[];
  /** Shared secret for the internal server-to-server bridge (FastAPI -> auth service). */
  internalSecret: string;
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
  /** Development-only dummy login. Never honored in production. */
  devLoginEnabled: boolean;
  /** Emails provisioned as deployment operators on first sign-in. */
  operatorEmails: string[];
  emailWebhookUrl?: string;
  /**
   * How long ended/renewed sessions remain visible in a device's history, in
   * days. Policy-driven so the retention window can change without touching
   * the grouping code. Active sessions are always shown regardless.
   */
  sessionHistoryRetentionDays: number;
};

function readSecret(name: string): string | undefined {
  const filePath = process.env[`${name}_FILE`];
  const direct = process.env[name];
  if (filePath && direct) {
    throw new Error(`Set only ${name} or ${name}_FILE, not both`);
  }
  if (filePath) {
    return readFileSync(filePath, "utf8").trim();
  }
  return direct?.trim() || undefined;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 8001;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`AUTH_PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

// Session-history retention is a policy knob, not a hardcoded constant: the
// device view keeps ended sessions for this many days before dropping them.
export function parseRetentionDays(raw: string | undefined, fallback = 30): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(`AUTH_SESSION_HISTORY_RETENTION_DAYS must be an integer between 1 and 365, got ${JSON.stringify(raw)}`);
  }
  return days;
}

// Organization tenancy serves the app on per-org subdomains of each
// configured origin, so every explicit origin also trusts its subdomains.
// Configured origins stay first: env.trustedOrigins[0] is the primary URL.
export function withSubdomainWildcards(origins: string[]): string[] {
  const expanded = [...origins];
  for (const origin of origins) {
    if (origin.includes("*")) continue;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    // IP literals have no subdomains.
    if (/^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) continue;
    const wildcard = `${url.protocol}//*.${url.host}`;
    if (!expanded.includes(wildcard)) expanded.push(wildcard);
  }
  return expanded;
}

// Bootstrap operators come from CARACAL_OPERATOR_EMAILS; the dev identity is
// also an operator whenever dev login is live so a local stack has a console
// admin. Case-insensitive and de-duplicated.
export function resolveOperatorEmails(raw: string | undefined, devLoginEnabled: boolean): string[] {
  return Array.from(
    new Set(
      (raw ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean)
        .concat(devLoginEnabled ? ["dev@localhost.caracal"] : []),
    ),
  );
}

export function loadEnv(): Env {
  const isProduction = process.env.NODE_ENV === "production";

  const secret = readSecret("BETTER_AUTH_SECRET");
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is required (32+ random bytes; generate with `openssl rand -base64 32`)");
  }
  if (isProduction && secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters in production");
  }

  const internalSecret = readSecret("AUTH_INTERNAL_SECRET");
  if (!internalSecret) {
    throw new Error("AUTH_INTERNAL_SECRET is required (shared with the API service)");
  }

  const baseURL = required("BETTER_AUTH_URL", process.env.BETTER_AUTH_URL).replace(/\/+$/, "");

  const googleId = process.env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = readSecret("GOOGLE_CLIENT_SECRET");
  const githubId = process.env.GITHUB_CLIENT_ID?.trim();
  const githubSecret = readSecret("GITHUB_CLIENT_SECRET");

  // The development sign-in method owns its environment decision; see
  // devLoginPermitted for the three server-side conditions it requires.
  const devLoginEnabled = devLoginPermitted({
    nodeEnv: process.env.NODE_ENV,
    devLoginFlag: process.env.AUTH_DEV_LOGIN,
    baseURL,
  });

  // Bootstrap operators come from the environment; the dev identity is an
  // operator whenever dev login is live so a local stack has a console admin.
  const operatorEmails = resolveOperatorEmails(process.env.CARACAL_OPERATOR_EMAILS, devLoginEnabled);

  return {
    isProduction,
    port: parsePort(process.env.AUTH_PORT),
    baseURL,
    basePath: process.env.AUTH_BASE_PATH ?? "/api/auth",
    databaseUrl: required("DATABASE_URL", readSecret("DATABASE_URL")),
    secret,
    trustedOrigins: withSubdomainWildcards(
      (process.env.AUTH_TRUSTED_ORIGINS ?? baseURL)
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
    internalSecret,
    google: googleId && googleSecret ? { clientId: googleId, clientSecret: googleSecret } : undefined,
    github: githubId && githubSecret ? { clientId: githubId, clientSecret: githubSecret } : undefined,
    devLoginEnabled,
    operatorEmails,
    emailWebhookUrl: process.env.AUTH_EMAIL_WEBHOOK_URL?.trim() || undefined,
    sessionHistoryRetentionDays: parseRetentionDays(process.env.AUTH_SESSION_HISTORY_RETENTION_DAYS),
  };
}

export const env = loadEnv();
