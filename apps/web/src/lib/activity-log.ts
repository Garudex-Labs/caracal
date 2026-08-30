// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side helpers for the cursor-paginated organization audit and security
 * feeds. The server exposes an opaque, forward-only cursor; a small cursor
 * stack reconstructs Previous/Next, and the active sort + filters + cursor are
 * mirrored into the URL so a page is shareable and survives a reload.
 */

export type ActivitySort = "desc" | "asc";

/** Active equality filters keyed by their API query-parameter name. */
export type ActivityFilters = Record<string, string>;

export interface ActivityQueryState {
	sort: ActivitySort;
	filters: ActivityFilters;
	cursor: string | null;
}

/** Drops blank filter values so the URL and request stay minimal. */
export function cleanFilters(filters: ActivityFilters): ActivityFilters {
	const out: ActivityFilters = {};
	for (const [key, value] of Object.entries(filters)) {
		const trimmed = value.trim();
		if (trimmed) out[key] = trimmed;
	}
	return out;
}

/** Builds the API request query params for one page. */
export function activityRequestParams(state: ActivityQueryState): Record<string, string> {
	const params: Record<string, string> = {};
	if (state.sort === "asc") params.dir = "asc";
	for (const [key, value] of Object.entries(cleanFilters(state.filters))) params[key] = value;
	if (state.cursor) params.cursor = state.cursor;
	return params;
}

/**
 * A cursor stack: index 0 is always the first page (a null cursor). Advancing
 * pushes the server's next_cursor; going back pops it. This is the only way to
 * page backwards over an opaque forward-only cursor.
 */
export type CursorStack = readonly (string | null)[];

export const initialCursorStack: CursorStack = [null];

export function currentCursor(stack: CursorStack): string | null {
	return stack[stack.length - 1] ?? null;
}

/** 1-based page number for display. */
export function pageNumber(stack: CursorStack): number {
	return stack.length;
}

export function canGoBack(stack: CursorStack): boolean {
	return stack.length > 1;
}

export function advance(stack: CursorStack, nextCursor: string): CursorStack {
	return [...stack, nextCursor];
}

export function goBack(stack: CursorStack): CursorStack {
	return stack.length > 1 ? stack.slice(0, -1) : stack;
}

/**
 * Reads sort + filters + cursor from URL search params (e.g. on reload). Only
 * the known filter keys are read, so a crafted query cannot inject arbitrary
 * request parameters.
 */
export function activityStateFromSearch(search: URLSearchParams, filterKeys: readonly string[]): ActivityQueryState {
	const filters: ActivityFilters = {};
	for (const key of filterKeys) {
		const value = search.get(key);
		if (value) filters[key] = value;
	}
	return {
		sort: search.get("dir") === "asc" ? "asc" : "desc",
		filters,
		cursor: search.get("cursor"),
	};
}

/** Serializes state into URL search params for history sync. */
export function activityStateToSearch(state: ActivityQueryState): URLSearchParams {
	return new URLSearchParams(activityRequestParams(state));
}
