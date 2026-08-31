// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	isValidPromptCategory,
	normalizePromptCategory,
	PROMPT_CATEGORIES,
	PROMPT_CATEGORY_MAX_LEN,
} from "./prompt-category.ts";

test("accepts valid custom categories", () => {
	assert.equal(normalizePromptCategory("refactoring"), "refactoring");
	assert.equal(normalizePromptCategory("security-audit"), "security-audit");
	assert.equal(normalizePromptCategory("data123"), "data123");
	assert.ok(isValidPromptCategory("prompt-engineering"));
});

test("rejects invalid input", () => {
	for (const raw of ["", "   ", "!!!", "///", "@#$%", "...", "---", "__"]) {
		assert.equal(normalizePromptCategory(raw), "");
		assert.equal(isValidPromptCategory(raw), false);
	}
});

test("canonicalizes casing, whitespace, dots, and underscores", () => {
	assert.equal(normalizePromptCategory("Code Review"), "code-review");
	assert.equal(normalizePromptCategory("code_review"), "code-review");
	assert.equal(normalizePromptCategory("  DEBUG  "), "debug");
	assert.equal(normalizePromptCategory("Code   Generation"), "code-generation");
	assert.equal(normalizePromptCategory("docs.api"), "docs-api");
	assert.equal(normalizePromptCategory("lots---of---dashes"), "lots-of-dashes");
	assert.equal(normalizePromptCategory("-leading-trailing-"), "leading-trailing");
});

test("enforces the maximum length", () => {
	const atLimit = "a".repeat(PROMPT_CATEGORY_MAX_LEN);
	assert.equal(normalizePromptCategory(atLimit), atLimit);
	assert.ok(isValidPromptCategory(atLimit));
	const overLimit = "a".repeat(PROMPT_CATEGORY_MAX_LEN + 1);
	assert.equal(isValidPromptCategory(overLimit), false);
});

test("deduplicates equivalent spellings to one slug", () => {
	const variants = ["Code Review", "code_review", "code-review", "CODE-REVIEW", "  code   review  "];
	for (const v of variants) {
		assert.equal(normalizePromptCategory(v), "code-review");
	}
});

test("never emits path-manipulation characters", () => {
	for (const raw of ["../../etc/passwd", "a/b/c", "foo/../bar"]) {
		const slug = normalizePromptCategory(raw);
		assert.ok(!slug.includes("/"));
		assert.ok(!slug.includes("\\"));
		assert.ok(!slug.includes(".."));
		assert.ok(!slug.includes(" "));
	}
});

test("recommended set is the curated slugs without system-prompt", () => {
	assert.deepEqual(PROMPT_CATEGORIES, [
		"general",
		"code-review",
		"code-generation",
		"debugging",
		"documentation",
		"testing",
	]);
	assert.ok(!PROMPT_CATEGORIES.includes("system-prompt" as never));
	// Every recommended value is itself a valid, already-normalized slug.
	for (const c of PROMPT_CATEGORIES) {
		assert.equal(normalizePromptCategory(c), c);
	}
});
