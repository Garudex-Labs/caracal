// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { searchEnum, searchString } from "./search-params.ts";

test("searchString accepts only non-empty strings", () => {
	assert.equal(searchString("agents"), "agents");
	assert.equal(searchString(""), undefined);
	assert.equal(searchString(undefined), undefined);
	assert.equal(searchString(null), undefined);
});

test("searchString rejects crafted non-string query values", () => {
	assert.equal(searchString(42), undefined);
	assert.equal(searchString(["a", "b"]), undefined);
	assert.equal(searchString({ toString: () => "x" }), undefined);
	assert.equal(searchString(true), undefined);
});

test("searchEnum admits only the allowed literals", () => {
	const allowed = new Set(["asc", "desc"] as const);
	assert.equal(searchEnum("asc", allowed), "asc");
	assert.equal(searchEnum("desc", allowed), "desc");
	assert.equal(searchEnum("ASC", allowed), undefined);
	assert.equal(searchEnum("drop table", allowed), undefined);
	assert.equal(searchEnum(["asc"], allowed), undefined);
	assert.equal(searchEnum(1, allowed), undefined);
	assert.equal(searchEnum(undefined, allowed), undefined);
});
