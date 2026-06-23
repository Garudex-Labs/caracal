// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime configuration for the Community Edition authentication service.

import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface AuthConfig {
  port: number;
  baseURL: string;
  secret: string;
  databasePath: string;
  webOrigin: string;
}

export function loadConfig(): AuthConfig {
  const port = Number(process.env.CARACAL_AUTH_PORT ?? 3002);
  const baseURL = process.env.CARACAL_AUTH_URL ?? `http://localhost:${port}`;
  const webOrigin = process.env.CARACAL_WEB_ORIGIN ?? "http://localhost:3001";
  const secret = process.env.BETTER_AUTH_SECRET ?? "caracal-community-dev-secret-change-me";
  const databasePath = process.env.CARACAL_AUTH_DB ?? path.resolve(here, "..", "caracal-auth.sqlite");
  return { port, baseURL, secret, databasePath, webOrigin };
}
