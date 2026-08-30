// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
process.env.AUTH_INTERNAL_SECRET ??= "internal-secret";
process.env.BETTER_AUTH_URL ??= "http://localhost:8001";
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/caracal";

test("internal bridge does not expose API key lifecycle routes", async () => {
  const { handleInternal } = await import("./internal.js");
  const request = new Request("http://localhost/internal/api-key", {
    method: "POST",
    headers: { "x-internal-secret": "unused" },
  });
  assert.equal(await handleInternal({} as never, "/internal/api-key", request), null);
  assert.equal(await handleInternal({} as never, "/internal/verify-api-key", request), null);
});
