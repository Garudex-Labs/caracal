// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Temporary development helper that wipes all authentication data for repeated local testing.

import { DatabaseSync } from "node:sqlite";

import type { AuthConfig } from "./config.ts";

const TABLES = ["session", "account", "verification", "user"];

export interface DevResetResult {
  cleared: string[];
}

/** Delete every row from the authentication tables so the next sign-up starts clean. */
export function devReset(cfg: AuthConfig): DevResetResult {
  const db = new DatabaseSync(cfg.databasePath);
  const cleared: string[] = [];
  try {
    for (const table of TABLES) {
      try {
        db.exec(`DELETE FROM ${table}`);
        cleared.push(table);
      } catch {
        // Table may not exist yet; ignore.
      }
    }
  } finally {
    db.close();
  }
  return { cleared };
}
