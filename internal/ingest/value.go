// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"math"
	"strconv"
	"strings"
)

// Transcript lines decode to map[string]any and every field is hostile.
// These helpers implement the field-access semantics pinned by the golden
// fixtures in contracts/session-goldens: type-guarded access, permissive
// truthiness, lenient scalar coercion, and code-point-based preview slicing.

const previewMax = 500

func strField(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func dictField(m map[string]any, key string) map[string]any {
	d, _ := m[key].(map[string]any)
	if d == nil {
		return map[string]any{}
	}
	return d
}

func listField(m map[string]any, key string) []any {
	l, _ := m[key].([]any)
	return l
}

// strOr returns the value if it is a string, else the fallback. Non-string
// values in string positions degrade to the fallback so one malformed block
// never voids a whole preview.
func strOr(v any, fallback string) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fallback
}

// truthy reports whether a decoded JSON value is non-empty: null, false,
// zero, "", empty arrays, and empty objects all read as empty.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}

// scalarString renders a decoded JSON scalar using the display conventions
// pinned by the golden fixtures: null reads "None", booleans "True"/"False",
// numbers without an exponent. Composite values render empty.
func scalarString(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case string:
		return x
	case bool:
		if x {
			return "True"
		}
		return "False"
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return ""
	}
}

// truncRunes slices by code points, not bytes, so multi-byte previews are
// never cut mid-character.
func truncRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// getOr returns the value at key, or the fallback only when the key is
// absent - a present null or falsy value passes through unchanged.
func getOr(m map[string]any, key string, fallback any) any {
	if v, ok := m[key]; ok {
		return v
	}
	return fallback
}

// firstTruthy returns a when it is non-empty, else b.
func firstTruthy(a, b any) any {
	if truthy(a) {
		return a
	}
	return b
}

// intOf coerces a token-count field to int: numbers truncate toward zero,
// numeric strings parse, and anything unconvertible reads as zero.
func intOf(v any) int {
	switch x := v.(type) {
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0
		}
		return int(x)
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64)
		if err != nil {
			return 0
		}
		return int(n)
	}
	return 0
}

// strPtr coerces an id-like field to *string: nil stays nil, strings pass
// through, other scalars are rendered.
func strPtr(v any) *string {
	if v == nil {
		return nil
	}
	s := scalarString(v)
	return &s
}

// isoToClickHouse converts "2026-01-01T12:00:00.123Z"-style values to
// "2026-01-01 12:00:00.123": render the scalar, replace T with a space,
// strip trailing Z, and ensure a fractional part.
func isoToClickHouse(raw any) string {
	if !truthy(raw) {
		return ""
	}
	ts := strings.TrimRight(strings.ReplaceAll(scalarString(raw), "T", " "), "Z")
	if !strings.Contains(ts, ".") {
		ts += ".000"
	}
	return ts
}
