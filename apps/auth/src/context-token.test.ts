// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Auth } from "./auth.js";
import { contextTokenPayload, mintContextToken, roleForContext } from "./context-token.js";

test("tenant context downgrades deployment operators to tenant users", () => {
	assert.equal(roleForContext("operator", "tenant"), "user");
	assert.deepEqual(contextTokenPayload({ id: "u1", email: "a@example.com", name: "A", role: "operator" }, "tenant"), {
		sub: "u1",
		email: "a@example.com",
		role: "user",
		name: "A",
		auth_context: "tenant",
	});
});

test("operator context requires deployment operator authority", () => {
	assert.equal(roleForContext("operator", "operator"), "operator");
	assert.equal(roleForContext("reviewer", "operator"), null);
	assert.equal(roleForContext("user", "operator"), null);
	assert.equal(contextTokenPayload({ id: "u1", role: "user" }, "operator"), null);
});

test("operator context accepts configured operator emails even for stored users", () => {
	assert.deepEqual(
		contextTokenPayload(
			{ id: "u1", email: "DEV@localhost.caracal", name: "Dev", role: "user" },
			"operator",
			["dev@localhost.caracal"],
		),
		{
			sub: "u1",
			email: "DEV@localhost.caracal",
			role: "operator",
			name: "Dev",
			auth_context: "operator",
		},
	);
});

test("tenant context preserves reviewer and defaults unknown roles to user", () => {
	assert.equal(roleForContext("reviewer", "tenant"), "reviewer");
	assert.equal(roleForContext("bogus", "tenant"), "user");
	assert.equal(roleForContext(undefined, "tenant"), "user");
});

function fakeAuth(user: Record<string, unknown> | null) {
	return {
		api: {
			getSession: async () => (user ? { user } : null),
			signJWT: async ({ body }: { body: { payload: Record<string, unknown> } }) => ({
				token: `signed:${body.payload.auth_context}:${body.payload.role}`,
			}),
		},
	} as unknown as Auth;
}

test("mintContextToken rejects missing sessions and non-operator operator contexts", async () => {
	const request = new Request("http://localhost/api/auth/operator-token");
	let response = await mintContextToken(fakeAuth(null), request, "operator");
	assert.equal(response.status, 401);

	response = await mintContextToken(fakeAuth({ id: "u1", email: "u@example.com", role: "user" }), request, "operator");
	assert.equal(response.status, 403);
});

test("mintContextToken signs context-specific payloads", async () => {
	const request = new Request("http://localhost/api/auth/operator-token");
	const response = await mintContextToken(
		fakeAuth({ id: "u1", email: "ops@example.com", name: "Ops", role: "user" }),
		request,
		"operator",
		["ops@example.com"],
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { token: "signed:operator:operator", auth_context: "operator" });
});
