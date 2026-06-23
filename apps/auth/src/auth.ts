// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Better Auth instance for Community Edition: unified email, Google, and GitHub identity backed by local SQLite.

import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";

import { authDatabase } from "./database.ts";
import { loadConfig } from "./config.ts";
import { githubCredentials, googleCredentials } from "./providers.ts";

const cfg = loadConfig();

function socialProviders(): NonNullable<BetterAuthOptions["socialProviders"]> {
  const providers: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  const google = googleCredentials();
  if (google) providers.google = google;
  const github = githubCredentials();
  if (github) providers.github = github;
  return providers;
}

export const auth = betterAuth({
  baseURL: cfg.baseURL,
  secret: cfg.secret,
  database: authDatabase,
  trustedOrigins: [cfg.webOrigin],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  socialProviders: socialProviders(),
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["email-password", "google", "github"],
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
});
