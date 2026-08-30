// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"math"
	"strings"
	"testing"
)

func TestScalarStringCases(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want string
	}{
		{"nil renders None", nil, "None"},
		{"string passthrough", "hello", "hello"},
		{"empty string", "", ""},
		{"bool true", true, "True"},
		{"bool false", false, "False"},
		{"integral float drops point", float64(4), "4"},
		{"negative integral float", float64(-12), "-12"},
		{"fractional float", 3.5, "3.5"},
		{"list is composite", []any{"a"}, ""},
		{"map is composite", map[string]any{"k": "v"}, ""},
		{"int is unsupported", 7, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := scalarString(tc.in); got != tc.want {
				t.Errorf("scalarString(%#v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestTruncRunesBoundaries(t *testing.T) {
	tests := []struct {
		name string
		s    string
		n    int
		want string
	}{
		{"shorter than limit", "abc", 5, "abc"},
		{"equal byte length", "abcde", 5, "abcde"},
		{"multibyte within rune limit", "\u00e1\u00e9\u00ed", 4, "\u00e1\u00e9\u00ed"}, // 6 bytes, 3 runes
		{"ascii truncated", "abcdef", 3, "abc"},
		{"multibyte truncated on rune boundary", "\u00e1\u00e9\u00ed\u00f3\u00fa", 3, "\u00e1\u00e9\u00ed"},
		{"zero limit", "abc", 0, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := truncRunes(tc.s, tc.n)
			if got != tc.want {
				t.Errorf("truncRunes(%q, %d) = %q, want %q", tc.s, tc.n, got, tc.want)
			}
			// Never split a code point.
			if strings.ToValidUTF8(got, "\uFFFD") != got {
				t.Errorf("truncRunes produced invalid UTF-8: %q", got)
			}
		})
	}
}

func TestIntOfCases(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want int
	}{
		{"bool true", true, 1},
		{"bool false", false, 0},
		{"whole float", float64(42), 42},
		{"float truncates toward zero", 3.9, 3},
		{"negative float truncates", -3.9, -3},
		{"NaN is zero", math.NaN(), 0},
		{"positive inf is zero", math.Inf(1), 0},
		{"negative inf is zero", math.Inf(-1), 0},
		{"numeric string", "128", 128},
		{"numeric string with spaces", "  256  ", 256},
		{"non-numeric string", "twelve", 0},
		{"empty string", "", 0},
		{"nil is zero", nil, 0},
		{"list is zero", []any{1}, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := intOf(tc.in); got != tc.want {
				t.Errorf("intOf(%#v) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

func TestTruthyCases(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want bool
	}{
		{"nil", nil, false},
		{"true", true, true},
		{"false", false, false},
		{"non-empty string", "x", true},
		{"empty string", "", false},
		{"non-zero float", 1.5, true},
		{"zero float", float64(0), false},
		{"non-empty list", []any{1}, true},
		{"empty list", []any{}, false},
		{"non-empty map", map[string]any{"k": 1}, true},
		{"empty map", map[string]any{}, false},
		{"unknown type is truthy", 7, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := truthy(tc.in); got != tc.want {
				t.Errorf("truthy(%#v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestFieldAndOrHelpers(t *testing.T) {
	m := map[string]any{
		"str":   "value",
		"num":   float64(3),
		"dict":  map[string]any{"inner": "x"},
		"list":  []any{"a", "b"},
		"null":  nil,
		"empty": "",
	}

	if got := strField(m, "str"); got != "value" {
		t.Errorf("strField str = %q", got)
	}
	if got := strField(m, "num"); got != "" {
		t.Errorf("strField on non-string = %q, want empty", got)
	}
	if got := strField(m, "missing"); got != "" {
		t.Errorf("strField missing = %q, want empty", got)
	}

	if d := dictField(m, "dict"); d["inner"] != "x" {
		t.Errorf("dictField = %#v", d)
	}
	if d := dictField(m, "str"); len(d) != 0 {
		t.Errorf("dictField on non-map should be empty, got %#v", d)
	}
	if d := dictField(m, "missing"); d == nil || len(d) != 0 {
		t.Errorf("dictField missing should be empty non-nil, got %#v", d)
	}

	if l := listField(m, "list"); len(l) != 2 {
		t.Errorf("listField = %#v", l)
	}
	if l := listField(m, "str"); l != nil {
		t.Errorf("listField on non-list = %#v, want nil", l)
	}

	if got := strOr(m["str"], "fb"); got != "value" {
		t.Errorf("strOr string = %q", got)
	}
	if got := strOr(m["num"], "fb"); got != "fb" {
		t.Errorf("strOr non-string = %q, want fallback", got)
	}

	// getOr: present null passes through; absent yields fallback.
	if got := getOr(m, "null", "fb"); got != nil {
		t.Errorf("getOr present null = %#v, want nil passthrough", got)
	}
	if got := getOr(m, "missing", "fb"); got != "fb" {
		t.Errorf("getOr missing = %#v, want fallback", got)
	}

	// firstTruthy prefers the first non-empty value.
	if got := firstTruthy("", "second"); got != "second" {
		t.Errorf("firstTruthy empty-first = %#v", got)
	}
	if got := firstTruthy("first", "second"); got != "first" {
		t.Errorf("firstTruthy truthy-first = %#v", got)
	}
}
