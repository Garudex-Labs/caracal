// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime configuration for the Community Edition authentication service.

import { resolveFileSecrets } from '@caracalai/server-core'

// Postgres TLS posture. "disable" relies on the connection string (default for the local
// stack), "require" enforces a verified certificate, and "no-verify" enables TLS without
// certificate verification for managed providers that present self-signed chains.
export type PostgresSsl = 'disable' | 'require' | 'no-verify'

export interface AuthConfig {
  port: number
  host: string
  baseURL: string
  secret: string
  webOrigins: string[]
  // The origin that serves the web console SPA, used to redirect OAuth errors back to a real UI
  // instead of the BFF's bare error page. In a split deployment (local dev) it is the Vite origin;
  // in a same-origin deployment it is the BFF's own origin, which serves the SPA.
  webAppOrigin: string
  webRoot?: string
  databaseUrl: string
  ssl: PostgresSsl
  production: boolean
  secureCookies: boolean
  autoProvisionDatabase: boolean
  openRegistration: boolean
  passwordSignup: boolean
  // Path to the Console sign-in allowlist managed by `caracal allowlist`; the file's entries
  // are re-read per request. Empty means no file-based admission policy, so access follows the
  // open-registration default.
  operatorAllowlistFile: string
  requireEmailVerification: boolean
  smtpUrl: string | null
  smtpFrom: string | null
}

function resolveDatabaseUrl(): string {
  // CARACAL_AUTH_DATABASE_URL isolates the auth schema in its own database; DATABASE_URL is
  // the platform-wide fallback. Both honour the `_FILE` secret convention.
  resolveFileSecrets(['CARACAL_AUTH_DATABASE_URL', 'DATABASE_URL'])
  const url = process.env.CARACAL_AUTH_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url || url.trim() === '') {
    throw new Error(
      'CARACAL_AUTH_DATABASE_URL is required. The auth service runs on PostgreSQL; start the stack with `caracal up` for local development, or set CARACAL_AUTH_DATABASE_URL (or CARACAL_AUTH_DATABASE_URL_FILE) to a Postgres connection string.',
    )
  }
  return url.trim()
}

function resolveSsl(production: boolean): PostgresSsl {
  const value = (process.env.CARACAL_AUTH_DATABASE_SSL ?? '').toLowerCase()
  if (value === 'require' || value === 'true' || value === 'verify') return 'require'
  if (value === 'no-verify' || value === 'insecure') return 'no-verify'
  if (value === 'disable' || value === 'false' || value === 'off') return 'disable'
  // Managed Postgres is the norm in production; default to a verified TLS channel unless an
  // operator explicitly opts out. Local development keeps the plaintext default.
  return production ? 'require' : 'disable'
}

function resolveSecret(): string {
  resolveFileSecrets(['CARACAL_AUTH_SECRET'])
  const secret = process.env.CARACAL_AUTH_SECRET
  // The signing secret protects every session cookie; a predictable value lets anyone forge
  // sessions. It is provisioned automatically for local development and required everywhere
  // else, so fail closed rather than run without one.
  if (!secret || secret.trim() === '') {
    throw new Error(
      'CARACAL_AUTH_SECRET is required. It is provisioned automatically by `caracal web`; for other deployments set CARACAL_AUTH_SECRET (or CARACAL_AUTH_SECRET_FILE) to a high-entropy random value.',
    )
  }
  return secret.trim()
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

// The browser origins permitted to drive credentialed requests. In the same-origin
// production image the SPA is served by this service, so its own origin is always trusted;
// CARACAL_WEB_ORIGIN additionally accepts a comma-separated allowlist for split deployments
// (apex+www, staging) and for local development where the Vite dev server is a separate origin.
// The localhost dev origin is only seeded outside production so a production allowlist never
// silently trusts a developer machine's origin.
function resolveWebOrigins(baseURL: string, production: boolean): string[] {
  const origins = new Set<string>()
  const self = originOf(baseURL)
  if (self) origins.add(self)
  const configured = process.env.CARACAL_WEB_ORIGIN ?? (production ? '' : 'http://localhost:3001')
  for (const entry of configured.split(',')) {
    const origin = originOf(entry.trim())
    if (origin) origins.add(origin)
  }
  return [...origins]
}

// The origin that serves the web console SPA. A split deployment (local dev's separate Vite
// server) exposes the SPA on a different origin than the auth BFF, so an OAuth error must redirect
// there rather than to the BFF, which serves no UI. A same-origin deployment serves the SPA from
// the BFF itself, so its own origin is correct. Resolve the first trusted origin that is not the
// BFF's own, falling back to the BFF origin.
function resolveWebAppOrigin(baseURL: string, webOrigins: string[]): string {
  const self = originOf(baseURL)
  return webOrigins.find((origin) => origin !== self) ?? self ?? baseURL
}

// The SMTP relay that delivers password reset and email verification messages. The URL carries
// host, port, and credentials (smtp:// or smtps://) and honours the `_FILE` secret convention;
// the From address is required alongside it so mail is never sent with a relay-invented sender.
function resolveSmtp(): { url: string | null; from: string | null } {
  resolveFileSecrets(['CARACAL_SMTP_URL'])
  const url = process.env.CARACAL_SMTP_URL?.trim() || null
  const from = process.env.CARACAL_SMTP_FROM?.trim() || null
  if (url && !from) {
    throw new Error(
      'CARACAL_SMTP_FROM is required when CARACAL_SMTP_URL is set. Set it to the sender address for password reset and verification emails, e.g. "Caracal <no-reply@example.com>".',
    )
  }
  return { url, from }
}

export function loadConfig(): AuthConfig {
  const production = (process.env.NODE_ENV ?? '').toLowerCase() === 'production'
  const port = Number(process.env.PORT ?? process.env.CARACAL_AUTH_PORT ?? 3002)
  const host = process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1')
  const baseURL = process.env.CARACAL_AUTH_URL ?? `http://localhost:${port}`
  // Cookies must carry Secure whenever the public edge is HTTPS. Production is HTTPS by
  // contract (TLS terminates at the edge even when this process speaks HTTP internally), so
  // default Secure on in production and honour an explicit override otherwise.
  const secureCookies =
    process.env.CARACAL_AUTH_SECURE_COOKIES !== undefined
      ? /^(1|true|yes|on)$/i.test(process.env.CARACAL_AUTH_SECURE_COOKIES)
      : production || baseURL.startsWith('https://')
  const webRoot = process.env.CARACAL_WEB_ROOT?.trim() || undefined
  // Per-replica DDL (CREATE DATABASE + Better Auth migrations) races under horizontal scaling
  // and needs an elevated role production deliberately withholds. Default it on for local
  // development and off for production, where the dedicated migration job owns schema changes.
  // An explicit CARACAL_AUTH_AUTO_MIGRATE wins either way, so a single-node self-host can opt in.
  const autoProvisionDatabase =
    process.env.CARACAL_AUTH_AUTO_MIGRATE !== undefined ? /^(1|true|yes|on)$/i.test(process.env.CARACAL_AUTH_AUTO_MIGRATE) : !production
  // A signed-in operator wields the shared global admin token, so registration is fail-closed in
  // production: without allowlist entries no one may register. Local development stays open so a
  // fresh stack is usable without configuration. Entries in the allowlist file are authoritative
  // at decision time and override this default whenever any exist.
  const openRegistration =
    process.env.CARACAL_OPEN_REGISTRATION !== undefined ? /^(1|true|yes|on)$/i.test(process.env.CARACAL_OPEN_REGISTRATION) : !production
  // Email/password sign-up grants admin on a self-asserted email that no one has proven the
  // registrant owns. With a domain-suffix allowlist that is an open admin door, and even an
  // exact-email allowlist is beatable by registering the address before its owner does. So
  // password sign-up is disabled in production by default - operators sign in through a
  // provider-verified identity (Google/GitHub) on the allowlist - and stays on in development for
  // usability. CARACAL_PASSWORD_SIGNUP forces it either way for self-hosts that wire email
  // verification. When it is on in production, email verification is required so an unverified
  // claim cannot mint a session.
  const passwordSignup =
    process.env.CARACAL_PASSWORD_SIGNUP !== undefined ? /^(1|true|yes|on)$/i.test(process.env.CARACAL_PASSWORD_SIGNUP) : !production
  const requireEmailVerification = production
  const smtp = resolveSmtp()
  // Password sign-up in production hinges on email verification, and verification hinges on a
  // mail transport. Without one every registration would stall unverified, so fail closed at
  // startup instead of deploying a sign-up flow that can never complete.
  if (production && passwordSignup && !smtp.url) {
    throw new Error(
      'CARACAL_PASSWORD_SIGNUP requires a mail transport in production: verification and reset emails cannot be delivered. Set CARACAL_SMTP_URL (or CARACAL_SMTP_URL_FILE) and CARACAL_SMTP_FROM, or disable password sign-up.',
    )
  }
  const webOrigins = resolveWebOrigins(baseURL, production)
  return {
    port,
    host,
    baseURL,
    webOrigins,
    webAppOrigin: resolveWebAppOrigin(baseURL, webOrigins),
    webRoot,
    databaseUrl: resolveDatabaseUrl(),
    ssl: resolveSsl(production),
    production,
    secureCookies,
    autoProvisionDatabase,
    openRegistration,
    passwordSignup,
    operatorAllowlistFile: process.env.CARACAL_OPERATOR_ALLOWLIST_FILE?.trim() ?? '',
    requireEmailVerification,
    smtpUrl: smtp.url,
    smtpFrom: smtp.from,
    secret: resolveSecret(),
  }
}
