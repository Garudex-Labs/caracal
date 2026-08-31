// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package promptcat

import (
	"strings"
	"testing"
)

func TestNormalizeValidCustom(t *testing.T) {
	cases := map[string]string{
		"refactoring":            "refactoring",
		"security-audit":         "security-audit",
		"prompt-engineering":     "prompt-engineering",
		"data123":                "data123",
		"code-review":            "code-review", // a recommended value round-trips
		"performance-and-tuning": "performance-and-tuning",
	}
	for in, want := range cases {
		got, ok := Normalize(in)
		if !ok {
			t.Fatalf("Normalize(%q) unexpectedly rejected", in)
		}
		if got != want {
			t.Fatalf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeInvalid(t *testing.T) {
	for _, in := range []string{
		"",
		"   ",
		"\t\n",
		"!!!",
		"///",
		"@#$%",
		"...",
		"---",
		"__",
		"()[]",
	} {
		if got, ok := Normalize(in); ok {
			t.Fatalf("Normalize(%q) = %q, ok=true; want rejected", in, got)
		}
	}
}

func TestNormalizeCanonicalization(t *testing.T) {
	cases := map[string]string{
		"Code Review":        "code-review",
		"code_review":        "code-review",
		"  DEBUG  ":          "debug",
		"Code   Generation":  "code-generation",
		"docs.api":           "docs-api",
		"UPPER_snake.Case":   "upper-snake-case",
		"lots---of---dashes": "lots-of-dashes",
		"-leading-trailing-": "leading-trailing",
		"mixed 42_items.now": "mixed-42-items-now",
	}
	for in, want := range cases {
		got, ok := Normalize(in)
		if !ok {
			t.Fatalf("Normalize(%q) unexpectedly rejected", in)
		}
		if got != want {
			t.Fatalf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeMaxLength(t *testing.T) {
	atLimit := strings.Repeat("a", MaxCategoryLen)
	if got, ok := Normalize(atLimit); !ok || got != atLimit {
		t.Fatalf("Normalize(len=%d) = %q, ok=%v; want accepted", MaxCategoryLen, got, ok)
	}
	overLimit := strings.Repeat("a", MaxCategoryLen+1)
	if got, ok := Normalize(overLimit); ok {
		t.Fatalf("Normalize(len=%d) = %q, ok=true; want rejected", MaxCategoryLen+1, got)
	}
}

func TestNormalizeDeduplicatesEquivalentForms(t *testing.T) {
	// Every spelling of the same intent must converge to one stored slug so the
	// registry never accumulates casing/whitespace duplicates.
	variants := []string{"Code Review", "code_review", "code-review", "CODE-REVIEW", "  code   review  "}
	want := "code-review"
	for _, v := range variants {
		got, ok := Normalize(v)
		if !ok || got != want {
			t.Fatalf("Normalize(%q) = %q (ok=%v); want %q", v, got, ok, want)
		}
	}
}

func TestNormalizeIsPathSafe(t *testing.T) {
	for _, in := range []string{
		"../../etc/passwd",
		`..\..\windows`,
		"a/b/c",
		"foo/../bar",
		"nested.path.segment",
	} {
		got, ok := Normalize(in)
		if !ok {
			continue // rejecting outright is also path-safe
		}
		for _, bad := range []string{"/", `\`, "..", " "} {
			if strings.Contains(got, bad) {
				t.Fatalf("Normalize(%q) = %q contains unsafe %q", in, got, bad)
			}
		}
	}
}

func TestIsRecommended(t *testing.T) {
	if !IsRecommended("code-review") {
		t.Fatal("code-review should be recommended")
	}
	if IsRecommended("system-prompt") {
		t.Fatal("system-prompt was removed and must not be recommended")
	}
	if IsRecommended("refactoring") {
		t.Fatal("custom values are not recommended")
	}
}
