// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	activityRequestParams,
	activityStateFromSearch,
	activityStateToSearch,
	advance,
	canGoBack,
	cleanFilters,
	currentCursor,
	goBack,
	initialCursorStack,
	pageNumber,
	type ActivityQueryState,
} from "./activity-log.ts";

test("cleanFilters drops blank and whitespace-only values", () => {
	assert.deepEqual(cleanFilters({ action: "publish", outcome: "", actor: "  " }), { action: "publish" });
	assert.deepEqual(cleanFilters({ actor: "  dev@x.io  " }), { actor: "dev@x.io" });
});

test("activityRequestParams omits defaults and includes only active controls", () => {
	assert.deepEqual(activityRequestParams({ sort: "newest", filters: {}, cursor: null, pageSize: 20 }), {});
	assert.deepEqual(
		activityRequestParams({ sort: "oldest", filters: { action: "publish", outcome: "" }, cursor: "abc", pageSize: 50 }),
		{ sort: "oldest", page_size: "50", action: "publish", cursor: "abc" },
	);
});

test("cursor stack drives Previous/Next over a forward-only cursor", () => {
	let stack = initialCursorStack;
	assert.equal(pageNumber(stack), 1);
	assert.equal(currentCursor(stack), null);
	assert.equal(canGoBack(stack), false);

	stack = advance(stack, "c1");
	assert.equal(pageNumber(stack), 2);
	assert.equal(currentCursor(stack), "c1");
	assert.equal(canGoBack(stack), true);

	stack = advance(stack, "c2");
	assert.equal(pageNumber(stack), 3);
	assert.equal(currentCursor(stack), "c2");

	stack = goBack(stack);
	assert.equal(pageNumber(stack), 2);
	assert.equal(currentCursor(stack), "c1");

	// Going back never underflows past the first page.
	stack = goBack(goBack(goBack(stack)));
	assert.equal(pageNumber(stack), 1);
	assert.equal(currentCursor(stack), null);
	assert.equal(canGoBack(stack), false);
});

test("advance/goBack do not mutate the source stack", () => {
	const base = initialCursorStack;
	const next = advance(base, "c1");
	assert.notEqual(next, base);
	assert.equal(base.length, 1);
	assert.equal(goBack(base), base); // no-op returns the same reference
});

test("activityStateFromSearch reads only known filter keys", () => {
	const search = new URLSearchParams("sort=slowest&action=publish&page_size=100&evil=1&cursor=abc");
	const state = activityStateFromSearch(search, ["action", "outcome"]);
	assert.deepEqual(state, { sort: "newest", filters: { action: "publish" }, cursor: "abc", pageSize: 100 });
	assert.equal(activityStateFromSearch(search, ["action"], ["newest", "oldest", "slowest"]).sort, "slowest");
	// An unknown or invalid direction falls back to the default descending sort.
	assert.equal(activityStateFromSearch(new URLSearchParams("dir=sideways"), []).sort, "newest");
	assert.equal(activityStateFromSearch(new URLSearchParams("dir=asc"), []).sort, "oldest");
	assert.equal(activityStateFromSearch(new URLSearchParams("page_size=25"), []).pageSize, 20);
});

test("activityStateToSearch round-trips through activityStateFromSearch", () => {
	const state: ActivityQueryState = { sort: "oldest", filters: { action: "publish", actor: "dev@x.io" }, cursor: "c9", pageSize: 50 };
	const restored = activityStateFromSearch(activityStateToSearch(state), ["action", "actor"]);
	assert.deepEqual(restored, state);
});
