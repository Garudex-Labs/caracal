// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

// env.ts runs loadEnv() on import, so satisfy its required inputs first, then
// load the pure helper under test.
process.env.BETTER_AUTH_SECRET ??= "test-secret-please-ignore-0123456789";
process.env.AUTH_INTERNAL_SECRET ??= "test-internal-secret-0123456789";
process.env.BETTER_AUTH_URL ??= "http://localhost";
process.env.DATABASE_URL ??= "postgresql://localhost/test";

const { resolveOperatorEmails, parseRetentionDays } = await import("./env.js");

test("session-history retention defaults, parses, and rejects out-of-range values", () => {
	assert.equal(parseRetentionDays(undefined), 30);
	assert.equal(parseRetentionDays(""), 30);
	assert.equal(parseRetentionDays("7"), 7);
	assert.throws(() => parseRetentionDays("0"));
	assert.throws(() => parseRetentionDays("366"));
	assert.throws(() => parseRetentionDays("nope"));
});

test("configured operator emails are normalized and de-duplicated", () => {
	const got = resolveOperatorEmails("  RAWx18.dev@Gmail.com , ops@acme.io ,rawx18.dev@gmail.com", false);
	assert.deepEqual(got, ["rawx18.dev@gmail.com", "ops@acme.io"]);
});

test("dev login adds the local dev identity as an operator", () => {
	const got = resolveOperatorEmails("rawx18.dev@gmail.com", true);
	assert.ok(got.includes("rawx18.dev@gmail.com"));
	assert.ok(got.includes("dev@localhost.caracal"));
});

test("without dev login the dev identity is not an operator", () => {
	const got = resolveOperatorEmails("rawx18.dev@gmail.com", false);
	assert.deepEqual(got, ["rawx18.dev@gmail.com"]);
});

test("empty configuration yields no operators outside dev", () => {
	assert.deepEqual(resolveOperatorEmails(undefined, false), []);
	assert.deepEqual(resolveOperatorEmails("", false), []);
});

test("the dev identity is never duplicated when also listed explicitly", () => {
	const got = resolveOperatorEmails("dev@localhost.caracal", true);
	assert.deepEqual(got, ["dev@localhost.caracal"]);
});
