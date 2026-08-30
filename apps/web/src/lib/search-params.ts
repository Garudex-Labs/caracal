// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Narrowing for URL search params in route `validateSearch` hooks. Search
 * values are user input and can be arrays or numbers after parsing; these
 * validate instead of casting so a crafted query can't leak a mistyped
 * value into typed search state.
 */

/** A non-empty string search value, or undefined. */
export function searchString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** A search value that is one of the allowed literals, or undefined. */
export function searchEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
	return typeof value === "string" && (allowed as ReadonlySet<string>).has(value) ? (value as T) : undefined;
}
