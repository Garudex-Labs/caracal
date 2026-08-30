// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * The single Better Auth instance for Caracal.
 *
 * Everything authentication-related is Better Auth built-ins configured
 * here: email/password with verification and reset, Google/GitHub social
 * sign-in with verified-email account linking, passkeys, magic links,
 * sessions, JWTs (consumed by the Go API server via JWKS),
 * organizations/invitations, enterprise SSO (OIDC + SAML 2.0), and SCIM
 * directory sync.
 */

import { randomUUID } from "node:crypto";
import { passkey } from "@better-auth/passkey";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { createAccessControl } from "better-auth/plugins/access";
import { admin, bearer, deviceAuthorization, jwt, magicLink, organization } from "better-auth/plugins";
import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access";
import { Pool } from "pg";
import { deviceIdFromHeaders } from "./device-cookie.js";
import { sendEmail } from "./email.js";
import { env } from "./env.js";

const pool = new Pool({ connectionString: env.databaseUrl });

/** Shared connection pool; the capability layer probes registrations on it. */
export { pool };

/** Caracal's role hierarchy, stored on the Better Auth user record. */
export const ROLES = ["operator", "reviewer", "user"] as const;

/** Roles allowed to administer deployment-wide identity configuration. */
const ADMIN_ROLES = ["operator"] as const;

/** Better Auth's base user type predates the admin plugin's `role` column; narrow it in one place. */
function roleOf(user: unknown): string {
  const email = (user as { email?: unknown }).email;
  if (typeof email === "string" && env.operatorEmails.includes(email.toLowerCase())) {
    return "operator";
  }
  const role = (user as { role?: unknown }).role;
  return typeof role === "string" ? role : "user";
}

function isAdmin(user: unknown): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(roleOf(user));
}

function headersForHookContext(context: unknown): Headers | null {
  return (context as { headers?: Headers; request?: { headers?: Headers } } | null)?.headers ??
    (context as { request?: { headers?: Headers } } | null)?.request?.headers ??
    null;
}

// Identity-level access control for the role hierarchy. Reviewer
// capabilities are enforced by the registry API itself, so reviewers carry
// user-level identity permissions here.
const accessControl = createAccessControl(defaultStatements);
const accessRoles = {
  user: accessControl.newRole({ ...userAc.statements }),
  reviewer: accessControl.newRole({ ...userAc.statements }),
  operator: accessControl.newRole({ ...adminAc.statements }),
};

export const auth = betterAuth({
  baseURL: env.baseURL,
  basePath: env.basePath,
  secret: env.secret,
  database: pool,
  trustedOrigins: env.trustedOrigins,

  session: {
    additionalFields: {
      deviceId: {
        type: "string",
        required: false,
        input: false,
        returned: false,
      },
    },
  },

  advanced: {
    // The registry API and the Go ingest server key users by UUID.
    database: { generateId: () => randomUUID() },
    useSecureCookies: env.isProduction,
    ipAddress: {
      // nginx overwrites X-Real-IP on every proxied request, so the value
      // is trustworthy here and rate limits key per client instead of one
      // shared bucket for everyone behind the load balancer.
      ipAddressHeaders: ["x-real-ip"],
    },
  },

  rateLimit: {
    // Explicit so development stacks throttle exactly like production;
    // the built-in rules hold sign-in and sign-up to 3 attempts per 10s.
    enabled: true,
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    requireEmailVerification: env.isProduction,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your Caracal password",
        text: `Click the link to reset your password: ${url}`,
      });
    },
    revokeSessionsOnPasswordReset: true,
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Verify your Caracal email address",
        text: `Click the link to verify your email: ${url}`,
      });
    },
  },

  socialProviders: {
    ...(env.google ? { google: { ...env.google } } : {}),
    ...(env.github ? { github: { ...env.github } } : {}),
  },

  account: {
    accountLinking: {
      // Google and GitHub resolve to the same Caracal user when the
      // provider-verified email matches; no duplicate identities.
      enabled: true,
      trustedProviders: ["google", "github"],
    },
  },

  databaseHooks: {
    session: {
      create: {
        before: async (session, context) => {
          const deviceId = deviceIdFromHeaders(headersForHookContext(context));
          return deviceId ? { data: { ...session, deviceId } } : { data: session };
        },
      },
    },
    user: {
      create: {
        // Deployment operators are seeded from CARACAL_OPERATOR_EMAILS (plus
        // the dev identity in dev). Everyone else is a plain user and can be
        // promoted only from the operator console. Seeded operators are born
        // verified: no email delivery may exist yet on a fresh deployment.
        before: async (user) => {
          const email = (user.email ?? "").toLowerCase();
          if (env.operatorEmails.includes(email)) {
            return { data: { ...user, role: "operator", emailVerified: true } };
          }
          return { data: user };
        },
      },
    },
  },

  plugins: [
    admin({
      defaultRole: "user",
      adminRoles: [...ADMIN_ROLES],
      ac: accessControl,
      roles: accessRoles,
    }),
    jwt({
      jwt: {
        issuer: env.baseURL,
        audience: "caracal-api",
        expirationTime: "15m",
        definePayload: ({ user }) => ({
          email: user.email,
          role: roleOf(user),
          name: user.name,
        }),
      },
      jwks: {
        keyPairConfig: { alg: "ES256" },
      },
    }),
    // Lets non-browser clients (CLI, hooks) authenticate the session with
    // an Authorization header instead of cookies.
    bearer(),
    organization({
      sendInvitationEmail: async (invitation) => {
        await sendEmail({
          to: invitation.email,
          subject: `You have been invited to ${invitation.organization.name} on Caracal`,
          text: `Accept the invitation: ${env.trustedOrigins[0] ?? env.baseURL}/accept-invitation/${invitation.id}`,
        });
      },
    }),
    passkey(),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendEmail({
          to: email,
          subject: "Your Caracal sign-in link",
          text: `Click the link to sign in: ${url}`,
        });
      },
    }),
    deviceAuthorization({
      // The web app serves the verification page; the CLI polls for the token.
      verificationUri: "/device",
      expiresIn: "10m",
      interval: "5s",
    }),
    // SSO providers are deployment-wide: sign-in resolves an identity
    // provider from the user's email domain across every registered
    // provider. Registration must therefore be an admin-only operation -
    // the web UI's role guard is not a security boundary, so gate the
    // /sso/register endpoint here. providersLimit === 0 makes Better Auth
    // reject registration with FORBIDDEN for non-admins.
    sso({
      providersLimit: (user) => (isAdmin(user) ? 10 : 0),
    }),
    scim({
      // Connections are provisioned at runtime through the managed catalog
      // (admin-driven), digested with an HMAC secret of their own.
      connections: [],
      managedConnections: { credentialHashSecret: env.secret },
    }),
  ],
});

export type Auth = typeof auth;
