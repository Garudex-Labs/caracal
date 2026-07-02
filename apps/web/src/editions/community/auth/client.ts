/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file builds the Community Edition Better Auth client.
*/
import { inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { config } from "@/platform/config";

export const authClient = createAuthClient({
  baseURL: config.authBaseUrl,
  fetchOptions: { credentials: "include" },
  // Mirrors the auth service's user schema so the account-held guide progress is typed on
  // the session and writable through updateUser.
  plugins: [inferAdditionalFields({ user: { guides: { type: "string", required: false } } })],
});
