// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Better Auth instance for Community Edition: unified email, Google, and GitHub identity backed by PostgreSQL.

import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { APIError } from 'better-auth/api'

import { authDatabase } from './database.ts'
import { loadConfig, isOperatorAllowed } from './config.ts'
import { createMailer } from './mailer.ts'
import { githubCredentials, googleCredentials } from './providers.ts'
import { logger } from './logger.ts'

const cfg = loadConfig()
const mailer = createMailer(cfg)

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
    // Email/password registration asserts an email the registrant has not proven they own, which
    // would otherwise grant allowlisted admin to whoever claims the address first. Disable sign-up
    // in production by default (operators bootstrap through a provider-verified identity) and
    // require a verified email before a session is issued where sign-up is permitted.
    disableSignUp: !cfg.passwordSignup,
    requireEmailVerification: cfg.requireEmailVerification,
    // A password reset proves control of the mailbox, not possession of every signed-in device.
    // Revoke all existing sessions on reset so a compromised credential cannot keep riding an
    // already-established session after the owner rotates the password.
    revokeSessionsOnPasswordReset: true,
    // Reset delivery requires a mail transport; without one the endpoint stays registered but
    // refuses to send, and the web console hides the reset entry point via /providers.
    ...(mailer
      ? {
          sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
            await mailer.sendPasswordReset(user.email, url)
          },
        }
      : {}),
  },
  ...(mailer
    ? {
        emailVerification: {
          sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
            await mailer.sendEmailVerification(user.email, url)
          },
          // The verification link itself proves mailbox control, so completing it signs the
          // operator in directly instead of bouncing them back through the credential form.
          autoSignInAfterVerification: true,
        },
      }
    : {}),
  socialProviders: socialProviders(),
  account: {
    accountLinking: {
      enabled: true,
      // Only provider-verified identities are trusted for automatic linking. Trusting
      // email-password here would let an unverified password registration auto-link to an
      // existing Google/GitHub account that shares the address — an account-takeover path.
      trustedProviders: ['google', 'github'],
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
    // A console session carries the shared global admin token, so a forgotten or compromised
    // device must not retain access indefinitely. Bound every session to a fixed seven-day
    // lifetime measured from sign-in and never extend it on activity, so even a continuously
    // used session is forced back through authentication instead of rolling forward forever.
    expiresIn: 60 * 60 * 24 * 7,
    disableSessionRefresh: true,
  },
  // Redirect OAuth and verification errors to the web console's sign-in page rather than the BFF's
  // bare error page, which serves no UI (and is a different origin in a split deployment). A
  // replayed or expired OAuth callback — for example a back-navigation to a consumed state — then
  // lands on the real console: a still-valid session is forwarded straight to the app, and a
  // genuinely signed-out operator sees the sign-in screen instead of a dead error URL.
  onAPIError: {
    errorURL: `${cfg.webAppOrigin}/sign-in`,
  },
  // Throttle credential endpoints so a directly reachable auth surface cannot be brute-forced
  // or enumerated. The window is shared across all auth routes with a tighter ceiling on the
  // sign-in and sign-up paths.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    // In-memory counters fragment across replicas, letting an attacker multiply the budget by
    // the instance count; persist counters in the database in production so limits hold fleet-wide.
    storage: cfg.production ? 'database' : 'memory',
    customRules: {
      '/sign-in/email': { window: 60, max: 10 },
      '/sign-up/email': { window: 60, max: 5 },
      '/request-password-reset': { window: 60, max: 5 },
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
