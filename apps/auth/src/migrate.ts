// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/** Apply Better Auth schema migrations. Runs from the init container before the API starts. */

import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth.js";

const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);

if (toBeCreated.length === 0 && toBeAdded.length === 0) {
  console.info("[auth-service] schema up to date");
} else {
  console.info(
    `[auth-service] migrating: creating ${toBeCreated.length} table(s), altering ${toBeAdded.length} table(s)`,
  );
  await runMigrations();
  console.info("[auth-service] migrations applied");
}

process.exit(0);
