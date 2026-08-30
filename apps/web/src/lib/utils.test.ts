// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { cn, compactNumber, formatNumber } from "./utils.ts";

test("cn merges conditional classes and drops falsy entries", () => {
	assert.equal(cn("a", false && "b", undefined, "c"), "a c");
	assert.equal(cn(["a", { b: true, c: false }]), "a b");
});

test("cn resolves conflicting tailwind utilities to the last one", () => {
	assert.equal(cn("p-2", "p-4"), "p-4");
	assert.equal(cn("text-red-500", "text-blue-500"), "text-blue-500");
	// Non-conflicting utilities both survive.
	assert.equal(cn("p-2", "m-4"), "p-2 m-4");
});

test("compactNumber abbreviates large values", () => {
	assert.equal(compactNumber(950), "950");
	assert.equal(compactNumber(1200), "1.2K");
	assert.equal(compactNumber(3_400_000), "3.4M");
	assert.equal(compactNumber(0), "0");
});

test("formatNumber groups thousands and caps decimals", () => {
	assert.equal(formatNumber(1234567), "1,234,567");
	assert.equal(formatNumber(12.345, 2), "12.35");
	assert.equal(formatNumber(12.345), "12");
});
