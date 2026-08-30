// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCurrentOrg } from "./current-org.ts";
import type { Organization } from "./types/org.ts";

const org = (slug: string, role: Organization["role"] = "member"): Organization => ({
	id: slug,
	slug,
	name: slug,
	role,
});

test("single organization resolves naturally when no org was stored", () => {
	const acme = org("acme", "owner");
	assert.deepEqual(resolveCurrentOrg([acme], "", null), {
		currentOrg: acme,
		selectionInvalid: false,
		shouldRemember: true,
	});
});

test("single organization heals a stale stored plain-host selection", () => {
	const acme = org("acme", "owner");
	assert.deepEqual(resolveCurrentOrg([acme], "old-org", null), {
		currentOrg: acme,
		selectionInvalid: false,
		shouldRemember: true,
	});
});

test("multiple organizations still require an explicit valid selection", () => {
	const acme = org("acme", "owner");
	const beta = org("beta", "admin");
	assert.deepEqual(resolveCurrentOrg([acme, beta], "", null), {
		currentOrg: undefined,
		selectionInvalid: false,
		shouldRemember: false,
	});
	assert.deepEqual(resolveCurrentOrg([acme, beta], "missing", null), {
		currentOrg: undefined,
		selectionInvalid: true,
		shouldRemember: false,
	});
});

test("host organization remains a hard tenant boundary", () => {
	const acme = org("acme", "owner");
	assert.deepEqual(resolveCurrentOrg([acme], "", "missing"), {
		currentOrg: undefined,
		selectionInvalid: true,
		shouldRemember: false,
	});
});
