// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Client-side mirror of the server's internal/promptcat package. It is the
// single source of truth for Prompt categories in the web UI; the backend
// re-normalizes on write and remains authoritative.

// Curated set of Prompt categories surfaced as first-class choices. Kept small
// on purpose: broad task intents rather than form descriptors. Authors may also
// supply a custom value, normalized by normalizePromptCategory.
export const PROMPT_CATEGORIES = [
	"general",
	"code-review",
	"code-generation",
	"debugging",
	"documentation",
	"testing",
] as const;

// Sentinel selected in a category dropdown to reveal a free-form input.
export const PROMPT_CATEGORY_CUSTOM = "__custom__";

// Maximum length of a normalized category, matching promptcat.MaxCategoryLen.
export const PROMPT_CATEGORY_MAX_LEN = 32;

// normalizePromptCategory folds an arbitrary label into the canonical slug the
// server stores. It lower-cases, converts runs of whitespace/dots/underscores
// to a hyphen, strips characters outside [a-z0-9-], collapses repeated hyphens,
// and trims leading/trailing hyphens. It mirrors promptcat.Normalize exactly so
// the UI can preview the stored value; it does not enforce the length bound
// (callers check PROMPT_CATEGORY_MAX_LEN when they need to).
export function normalizePromptCategory(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[\s._]+/g, "-")
		.replace(/[^a-z0-9-]+/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

// isValidPromptCategory reports whether a raw label normalizes to a non-empty
// slug within the length bound, matching the server's accept/reject decision.
export function isValidPromptCategory(raw: string): boolean {
	const slug = normalizePromptCategory(raw);
	return slug !== "" && slug.length <= PROMPT_CATEGORY_MAX_LEN;
}
