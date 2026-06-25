// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime configuration for the Community Edition authentication service.

import { resolveFileSecrets } from "@caracalai/core";

// Postgres TLS posture. "disable" relies on the connection string (default for the local
// stack), "require" enforces a verified certificate, and "no-verify" enables TLS without
// certificate verification for managed providers that present self-signed chains.
export type PostgresSsl = "disable" | "require" | "no-verify";

export interface AuthConfig {
  port: number;
  host: string;
  baseURL: string;
  secret: string;
  webOrigins: string[];
  webRoot?: string;
  databaseUrl: string;
  ssl: PostgresSsl;
  production: boolean;
  secureCookies: boolean;
  autoProvisionDatabase: boolean;
}

function resolveDatabaseUrl(): string {
  // CARACAL_AUTH_DATABASE_URL isolates the auth schema in its own database; DATABASE_URL is
  // the platform-wide fallback. Both honour the `_FILE` secret convention.
  resolveFileSecrets(["CARACAL_AUTH_DATABASE_URL", "DATABASE_URL"]);
  const url = process.env.CARACAL_AUTH_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error(
      "CARACAL_AUTH_DATABASE_URL is required. The auth service runs on PostgreSQL; start the stack with `caracal up` for local development, or set CARACAL_AUTH_DATABASE_URL (or CARACAL_AUTH_DATABASE_URL_FILE) to a Postgres connection string.",
    );
  }
  return url.trim();
}

function resolveSsl(production: boolean): PostgresSsl {
  const value = (process.env.CARACAL_AUTH_DATABASE_SSL ?? "").toLowerCase();
  if (value === "require" || value === "true" || value === "verify") return "require";
  if (value === "no-verify" || value === "insecure") return "no-verify";
  // Managed Postgres is the norm in production; default to a verified TLS channel unless an
  // operator explicitly opts out. Local development keeps the plaintext default.
  return production ? "require" : "disable";
}

function resolveSecret(): string {
  resolveFileSecrets(["CARACAL_AUTH_SECRET"]);
  const secret = process.env.CARACAL_AUTH_SECRET;
  // The signing secret protects every session cookie; a predictable value lets anyone forge
  // sessions. It is provisioned automatically for local development and required everywhere
  // else, so fail closed rather than run without one.
  if (!secret || secret.trim() === "") {
    throw new Error(
      "CARACAL_AUTH_SECRET is required. It is provisioned automatically by `caracal web`; for other deployments set CARACAL_AUTH_SECRET (or CARACAL_AUTH_SECRET_FILE) to a high-entropy random value.",
    );
  }
  return secret.trim();
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

// The browser origins permitted to drive credentialed requests. In the same-origin
// production image the SPA is served by this service, so its own origin is always trusted;
// CARACAL_WEB_ORIGIN additionally accepts a comma-separated allowlist for split deployments
// (apex+www, staging) and for local development where the Vite dev server is a separate origin.
function resolveWebOrigins(baseURL: string): string[] {
  const origins = new Set<string>();
  const self = originOf(baseURL);
  if (self) origins.add(self);
  const configured = process.env.CARACAL_WEB_ORIGIN ?? "http://localhost:3001";
  for (const entry of configured.split(",")) {
    const origin = originOf(entry.trim());
    if (origin) origins.add(origin);
  }
  return [...origins];
}

export function loadConfig(): AuthConfig {
  const production = (process.env.NODE_ENV ?? "").toLowerCase() === "production";
  const port = Number(process.env.PORT ?? process.env.CARACAL_AUTH_PORT ?? 3002);
  const host = process.env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1");
  const baseURL = process.env.CARACAL_AUTH_URL ?? `http://localhost:${port}`;
  // Cookies must carry Secure whenever the public edge is HTTPS. Production is HTTPS by
  // contract (TLS terminates at the edge even when this process speaks HTTP internally), so
  // default Secure on in production and honour an explicit override otherwise.
  const secureCookies =
    process.env.CARACAL_AUTH_SECURE_COOKIES !== undefined
      ? /^(1|true|yes|on)$/i.test(process.env.CARACAL_AUTH_SECURE_COOKIES)
      : production || baseURL.startsWith("https://");
  const webRoot = process.env.CARACAL_WEB_ROOT?.trim() || undefined;
  // Per-replica DDL (CREATE DATABASE + Better Auth migrations) races under horizontal scaling
  // and needs an elevated role production deliberately withholds. Auto-provision only for local
  // development; production runs migrations once through the dedicated migration job.
  const autoProvisionDatabase = !production && process.env.CARACAL_AUTH_AUTO_MIGRATE !== "false";
  return {
    port,
    host,
    baseURL,
    webOrigins: resolveWebOrigins(baseURL),
    webRoot,
    databaseUrl: resolveDatabaseUrl(),
    ssl: resolveSsl(production),
    production,
    secureCookies,
    autoProvisionDatabase,
    secret: resolveSecret(),
  };
}
