// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"encoding/json"
	"testing"
)

// mustObj decodes a JSON object literal into an *Obj for test inputs.
func mustObj(t *testing.T, raw string) *Obj {
	t.Helper()
	v, err := DecodeValue([]byte(raw))
	if err != nil {
		t.Fatalf("decode %q: %v", raw, err)
	}
	obj, ok := v.(*Obj)
	if !ok {
		t.Fatalf("decode %q is %T, want *Obj", raw, v)
	}
	return obj
}

func TestScalarStringScalars(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want string
	}{
		{"nil", nil, "None"},
		{"true", true, "True"},
		{"false", false, "False"},
		{"string", "hi", "hi"},
		{"int number", json.Number("42"), "42"},
		{"float number", json.Number("3.14"), "3.14"},
		{"unsupported type", 7, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := scalarString(tc.in); got != tc.want {
				t.Errorf("scalarString(%#v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestScalarStringContainersUseDisplayForm(t *testing.T) {
	list := []any{json.Number("1"), "two", true, nil}
	if got, want := scalarString(list), "[1, 'two', True, None]"; got != want {
		t.Errorf("list display = %q, want %q", got, want)
	}

	obj := mustObj(t, `{"a":"x","b":2}`)
	if got, want := scalarString(obj), "{'a': 'x', 'b': 2}"; got != want {
		t.Errorf("obj display = %q, want %q", got, want)
	}

	// Nested list inside an object routes back through scalarString/writeDisplay.
	nested := mustObj(t, `{"items":["p","q"]}`)
	if got, want := scalarString(nested), "{'items': ['p', 'q']}"; got != want {
		t.Errorf("nested display = %q, want %q", got, want)
	}
}

func TestWriteDisplayEscapesQuotesAndBackslashes(t *testing.T) {
	// A single-element list forces writeDisplay to single-quote and escape.
	got := scalarString([]any{`a'b\c`})
	if want := `['a\'b\\c']`; got != want {
		t.Errorf("escaped display = %q, want %q", got, want)
	}
}

func TestFloatString(t *testing.T) {
	tests := []struct {
		name string
		in   float64
		want string
	}{
		{"integral gains suffix", 5, "5.0"},
		{"zero gains suffix", 0, "0.0"},
		{"negative integral", -2, "-2.0"},
		{"fractional untouched", 3.14, "3.14"},
		{"scientific keeps exponent", 1e21, "1e+21"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := floatString(tc.in); got != tc.want {
				t.Errorf("floatString(%v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestTruthyValues(t *testing.T) {
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
		{"zero number", json.Number("0"), false},
		{"non-zero number", json.Number("5"), true},
		{"unparsable number", json.Number("not-a-number"), false},
		{"non-empty list", []any{1}, true},
		{"empty list", []any{}, false},
		{"non-empty obj", mustObj(t, `{"a":1}`), true},
		{"empty obj", &Obj{}, false},
		{"unknown type", 7, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := truthy(tc.in); got != tc.want {
				t.Errorf("truthy(%#v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestNumberStringAndTruncChars(t *testing.T) {
	if got := numberString(json.Number("42")); got != "42" {
		t.Errorf("numberString = %q", got)
	}
	if got := truncChars("abc", 5); got != "abc" {
		t.Errorf("truncChars shorter = %q", got)
	}
	if got := truncChars("abcde", 5); got != "abcde" {
		t.Errorf("truncChars equal = %q", got)
	}
	// Multi-byte truncation must cut on a rune boundary.
	if got := truncChars("\u00e1\u00e9\u00ed\u00f3\u00fa", 3); got != "\u00e1\u00e9\u00ed" {
		t.Errorf("truncChars multibyte = %q", got)
	}
}

func TestStripANSI(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"no escapes passes through", "plain text", "plain text"},
		{"csi color codes", "\x1b[31mred\x1b[0m", "red"},
		{"osc sequence", "\x1b]0;title\x07body", "body"},
		{"simple escape", "\x1bMkeep", "keep"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := stripANSI(tc.in); got != tc.want {
				t.Errorf("stripANSI(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestStripCursorXMLTags(t *testing.T) {
	in := "<timestamp>2026-01-01</timestamp>\n<user_query>real question</user_query>"
	if got, want := stripCursorXMLTags(in), "real question"; got != want {
		t.Errorf("stripCursorXMLTags = %q, want %q", got, want)
	}

	in = "<system_reminder>ignore</system_reminder><attached_files>a.go</attached_files>keep"
	if got, want := stripCursorXMLTags(in), "ignorea.gokeep"; got != want {
		t.Errorf("stripCursorXMLTags reminders = %q, want %q", got, want)
	}
}

func TestOrEmpty(t *testing.T) {
	if got := orEmpty(nil); got != "" {
		t.Errorf("orEmpty(nil) = %q, want empty", got)
	}
	s := "value"
	if got := orEmpty(&s); got != "value" {
		t.Errorf("orEmpty(&s) = %q, want value", got)
	}
}

func TestPickTimestamp(t *testing.T) {
	tests := []struct {
		name       string
		jsonlTS    any
		rowTS      string
		ingestedAt string
		want       string
	}{
		{"iso with T and Z", "2026-05-01T12:00:00Z", "row", "ing", "2026-05-01 12:00:00"},
		{"iso with offset suffix", "2026-05-01T12:00:00+00:00", "row", "ing", "2026-05-01 12:00:00"},
		{"epoch sentinel falls to row", "1970-01-01T00:00:00Z", "2026-05-01 09:00:00", "ing", "2026-05-01 09:00:00"},
		{"empty jsonl uses row", "", "2026-05-01 09:00:00", "ing", "2026-05-01 09:00:00"},
		{"non-string jsonl uses row", json.Number("5"), "2026-05-01 09:00:00", "ing", "2026-05-01 09:00:00"},
		{"epoch row falls to ingested", nil, "1970-01-01 00:00:00", "2026-05-01 00:00:02", "2026-05-01 00:00:02"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := pickTimestamp(tc.jsonlTS, tc.rowTS, tc.ingestedAt); got != tc.want {
				t.Errorf("pickTimestamp(%#v, %q, %q) = %q, want %q", tc.jsonlTS, tc.rowTS, tc.ingestedAt, got, tc.want)
			}
		})
	}
}
