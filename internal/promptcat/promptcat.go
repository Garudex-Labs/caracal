// SPDX-License-Identifier: Apache-2.0

// Package promptcat is the single source of truth for Prompt category values.
// It is intentionally dependency-free so the server (internal/registry) and the
// CLI (cmd/caracal) share one recommended set and one normalization rule; the
// web UI mirrors the same rule client-side while the server stays authoritative.
package promptcat

import (
	"regexp"
	"strings"
)

// DefaultCategory is applied when no category is supplied.
const DefaultCategory = "general"

// MaxCategoryLen bounds a normalized category so it stays path-safe and
// display-friendly.
const MaxCategoryLen = 32

// Recommended is the curated set of Prompt categories surfaced as first-class
// choices in the CLI and web UIs. It is deliberately small: broad task intents
// rather than form descriptors. Authors may also supply a custom value, which
// is normalized by Normalize.
var Recommended = []string{
	"general",
	"code-review",
	"code-generation",
	"debugging",
	"documentation",
	"testing",
}

var (
	categorySeparators = regexp.MustCompile(`[\s._]+`)
	categoryDisallowed = regexp.MustCompile(`[^a-z0-9-]+`)
	categoryHyphenRun  = regexp.MustCompile(`-{2,}`)
)

// Normalize converts an arbitrary category label into the single canonical slug
// shared by every surface. It lower-cases the input, folds runs of whitespace,
// dots, and underscores to a hyphen, strips any character outside [a-z0-9-],
// collapses repeated hyphens, and trims leading and trailing hyphens. It
// returns ok=false when the input is blank, normalizes to an empty string, or
// exceeds MaxCategoryLen.
//
// Because predefined and custom values pass through the same function,
// "Code Review", "code_review", and "code-review" all converge to a single
// stored value, preventing casing and whitespace duplicates. Path-manipulation
// characters ('/', '\\', "..") never survive, so a normalized category can be
// used directly as a filename segment.
func Normalize(raw string) (string, bool) {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = categorySeparators.ReplaceAllString(s, "-")
	s = categoryDisallowed.ReplaceAllString(s, "")
	s = categoryHyphenRun.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" || len(s) > MaxCategoryLen {
		return "", false
	}
	return s, true
}

// IsRecommended reports whether slug is one of the curated Recommended
// categories. It does not normalize; callers should Normalize first.
func IsRecommended(slug string) bool {
	for _, c := range Recommended {
		if c == slug {
			return true
		}
	}
	return false
}
