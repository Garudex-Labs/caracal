// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Creates or updates the authentication database schema for the configured backend.

import { getMigrations } from "better-auth/db/migration";

import { auth } from "./auth.ts";

const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(auth.options);

if (toBeCreated.length === 0 && toBeAdded.length === 0) {
  console.log("auth schema already up to date");
} else {
  await runMigrations();
  console.log("auth schema migrated");
}
