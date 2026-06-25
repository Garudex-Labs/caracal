// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Better Auth instance for Community Edition: unified email, Google, and GitHub identity backed by PostgreSQL.

import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { APIError } from 'better-auth/api'

import { authDatabase } from './database.ts'
import { loadConfig, isOperatorAllowed } from './config.ts'
import { githubCredentials, googleCredentials } from './providers.ts'
import { logger } from './logger.ts'

const cfg = loadConfig()

function socialProviders(): NonNullable<BetterAuthOptions['socialProviders']> {
  const providers: NonNullable<BetterAuthOptions['socialProviders']> = {}
  const google = googleCredentials()
  if (google) providers.google = google
  const github = githubCredentials()
  if (github) providers.github = github
  return providers
}

export const auth = betterAuth({
  baseURL: cfg.baseURL,
  secret: cfg.secret,
  database: authDatabase,
  trustedOrigins: cfg.webOrigins,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  socialProviders: socialProviders(),
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ['email-password', 'google', 'github'],
    },
  },
  // Registration is an authority boundary: a signed-in operator is proxied with the shared global
  // admin token, so only allowlisted identities may create an account. This runs before any user
  // row is written and covers every path — email/password sign-up and social provider callbacks —
  // so an unlisted identity can never bootstrap a session in production.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (isOperatorAllowed(user.email, cfg)) return
          logger.warn('registration denied for unlisted operator', { email: user.email })
          throw new APIError('FORBIDDEN', { message: 'registration_not_permitted' })
        },
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  // Throttle credential endpoints so a directly reachable auth surface cannot be brute-forced
  // or enumerated. The window is shared across all auth routes with a tighter ceiling on the
  // sign-in and sign-up paths.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    customRules: {
      '/sign-in/email': { window: 60, max: 10 },
      '/sign-up/email': { window: 60, max: 10 },
      '/forget-password': { window: 60, max: 5 },
    },
  },
  advanced: {
    // The signing edge is HTTPS in production; pin Secure explicitly rather than inferring it
    // from the internal baseURL scheme, which is plain HTTP behind a TLS-terminating proxy.
    useSecureCookies: cfg.secureCookies,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
    },
  },
})
