// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resolves which authentication providers are configured for this installation.

import { resolveFileSecrets } from "@caracalai/core";

import type { AuthConfig } from "./config.ts";

export interface SocialProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface EnabledProviders {
  email: boolean;
  google: boolean;
  github: boolean;
  passwordReset: boolean;
}

// Provider client secrets follow the `_FILE` secret convention like every other credential, so
// they can be delivered as mounted secret files rather than inline environment values.
resolveFileSecrets([
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
]);

export function googleCredentials(): SocialProviderCredentials | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function githubCredentials(): SocialProviderCredentials | null {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function enabledProviders(cfg: AuthConfig): EnabledProviders {
  return {
    email: true,
    google: googleCredentials() !== null,
    github: githubCredentials() !== null,
    // Reset links travel by email, so the capability only exists when a mail transport is
    // configured; the web console hides its reset entry points when this is false.
    passwordReset: cfg.smtpUrl !== null,
  };
}
