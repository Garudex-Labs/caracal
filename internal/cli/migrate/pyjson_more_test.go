// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestDocSetReplaceAndGet(t *testing.T) {
	d := NewDoc().Set("a", 1).Set("b", 2)
	d.Set("a", 99) // replace in place, position preserved
	if keys := d.Keys(); len(keys) != 2 || keys[0] != "a" || keys[1] != "b" {
		t.Fatalf("keys after replace = %v, want [a b]", keys)
	}
	if v, ok := d.Get("a"); !ok || v != 99 {
		t.Fatalf("Get(a) = %v, %v, want 99, true", v, ok)
	}
	if v, ok := d.Get("missing"); ok || v != nil {
		t.Fatalf("Get(missing) = %v, %v, want nil, false", v, ok)
	}
}

func TestDocAccessors(t *testing.T) {
	d := NewDoc().
		Set("child", NewDoc().Set("inner", "leaf")).
		Set("name", "caracal").
		Set("count", json.Number("7")).
		Set("ratio", json.Number("3.9")).
		Set("notnum", "5").
		Set("num", 42)

	if got := d.GetDoc("child").GetString("inner"); got != "leaf" {
		t.Fatalf("GetDoc(child).inner = %q, want leaf", got)
	}
	if got := d.GetDoc("missing"); len(got.Keys()) != 0 {
		t.Fatalf("GetDoc(missing) should be empty, got %v", got.Keys())
	}
	if got := d.GetDoc("name"); len(got.Keys()) != 0 {
		t.Fatal("GetDoc on a non-object value must return an empty Doc")
	}

	if got := d.GetString("name"); got != "caracal" {
		t.Fatalf("GetString(name) = %q", got)
	}
	if got := d.GetString("missing"); got != "" {
		t.Fatalf("GetString(missing) = %q, want empty", got)
	}
	if got := d.GetString("num"); got != "" {
		t.Fatal("GetString on a non-string value must return empty")
	}

	if got := d.GetInt("count"); got != 7 {
		t.Fatalf("GetInt(count) = %d, want 7", got)
	}
	if got := d.GetInt("ratio"); got != 3 {
		t.Fatalf("GetInt(ratio) = %d, want 3 (float truncation)", got)
	}
	if got := d.GetInt("missing"); got != 0 {
		t.Fatalf("GetInt(missing) = %d, want 0", got)
	}
	if got := d.GetInt("notnum"); got != 0 {
		t.Fatalf("GetInt on a plain string = %d, want 0", got)
	}
}

func TestPyStrControlAndAstral(t *testing.T) {
	cases := map[string]string{
		"\b\f\r":     `"\b\f\r"`,
		"\x01":       `"\u0001"`,
		"\x7f":       `"\u007f"`,
		" ~":         `" ~"`,
		"\u00e9":     `"\u00e9"`,
		"\U0001F600": `"\ud83d\ude00"`,
		"plain":      `"plain"`,
	}
	for in, want := range cases {
		if got := pyStr(in); got != want {
			t.Fatalf("pyStr(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestPyFloatSpecialsAndBoundaries(t *testing.T) {
	if got := pyFloat(math.NaN()); got != "NaN" {
		t.Fatalf("pyFloat(NaN) = %s", got)
	}
	if got := pyFloat(math.Inf(1)); got != "Infinity" {
		t.Fatalf("pyFloat(+Inf) = %s", got)
	}
	if got := pyFloat(math.Inf(-1)); got != "-Infinity" {
		t.Fatalf("pyFloat(-Inf) = %s", got)
	}
	cases := map[float64]string{
		0.0001:    "0.0001",    // exponent -4 stays fixed
		100000.0:  "100000.0",  // integral fixed keeps .0
		1234567.0: "1234567.0", // fixed notation
		-12.5:     "-12.5",     // negative fixed
	}
	for value, want := range cases {
		if got := pyFloat(value); got != want {
			t.Fatalf("pyFloat(%v) = %s, want %s", value, got, want)
		}
	}
}

func TestRound2AndFormatFloat(t *testing.T) {
	cases := map[float64]float64{
		3.14159: 3.14,
		1.239:   1.24,
		5.0:     5.0,
		0.0:     0.0,
	}
	for in, want := range cases {
		if got := round2(in); got != want {
			t.Fatalf("round2(%v) = %v, want %v", in, got, want)
		}
	}
	if FormatFloat(1.5) != pyFloat(1.5) || FormatFloat(1.5) != "1.5" {
		t.Fatalf("FormatFloat should wrap pyFloat: %s", FormatFloat(1.5))
	}
}

func TestDumpValueTypes(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want string
	}{
		{"bool true", true, "true"},
		{"bool false", false, "false"},
		{"int", 5, "5"},
		{"int64", int64(9), "9"},
		{"float64", 2.5, "2.5"},
		{"json number", json.Number("42"), "42"},
		{"nil", nil, "null"},
		{"string", "hi", `"hi"`},
		{"string slice", []string{"a", "b"}, `["a", "b"]`},
		{"any slice", []any{1, "x", true, nil}, `[1, "x", true, null]`},
		{"doc", NewDoc().Set("k", "v"), `{"k": "v"}`},
		{"nested", NewDoc().Set("a", []any{int64(1), NewDoc().Set("b", 2)}), `{"a": [1, {"b": 2}]}`},
		{"default fallback", uint(5), `"5"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := dumps(tc.in); got != tc.want {
				t.Fatalf("dumps(%v) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestDumpsIndentNested(t *testing.T) {
	doc := NewDoc().
		Set("list", []string{"x", "y"}).
		Set("nested", []any{NewDoc().Set("a", int64(1))})
	want := strings.Join([]string{
		`{`,
		`  "list": [`,
		`    "x",`,
		`    "y"`,
		`  ],`,
		`  "nested": [`,
		`    {`,
		`      "a": 1`,
		`    }`,
		`  ]`,
		`}`,
	}, "\n")
	if got := dumpsIndent(doc); got != want {
		t.Fatalf("dumpsIndent nested mismatch:\n%s", got)
	}
}

func TestParseOrderedRoundTrip(t *testing.T) {
	src := `{"a": [1, true, null, {"b": "c"}], "d": 2}`
	parsed, err := parseOrdered([]byte(src))
	if err != nil {
		t.Fatalf("parseOrdered: %v", err)
	}
	doc, ok := parsed.(*Doc)
	if !ok {
		t.Fatalf("parseOrdered top value is %T, want *Doc", parsed)
	}
	if keys := doc.Keys(); len(keys) != 2 || keys[0] != "a" || keys[1] != "d" {
		t.Fatalf("key order = %v, want [a d]", keys)
	}
	list, ok := func() ([]any, bool) { v, _ := doc.Get("a"); l, ok := v.([]any); return l, ok }()
	if !ok || len(list) != 4 {
		t.Fatalf("a = %v, want a 4-element array", list)
	}
	if doc.GetInt("d") != 2 {
		t.Fatalf("d = %d, want 2", doc.GetInt("d"))
	}
	// Re-rendering must reproduce the compact source exactly.
	if got := dumps(parsed); got != src {
		t.Fatalf("round-trip mismatch: %s", got)
	}
}

func TestParseOrderedScalarsAndErrors(t *testing.T) {
	if v, err := parseOrdered([]byte("42")); err != nil || v != json.Number("42") {
		t.Fatalf("top-level number = %v, %v", v, err)
	}
	if v, err := parseOrdered([]byte(`"str"`)); err != nil || v != "str" {
		t.Fatalf("top-level string = %v, %v", v, err)
	}
	for _, bad := range []string{"", "{", "[1", `{"a"`, "tru", "@", `{"a":}`} {
		if _, err := parseOrdered([]byte(bad)); err == nil {
			t.Fatalf("parseOrdered(%q) should error", bad)
		}
	}
}

func TestSortedStringsCopies(t *testing.T) {
	in := []string{"c", "a", "b"}
	out := sortedStrings(in)
	if strings.Join(out, ",") != "a,b,c" {
		t.Fatalf("sortedStrings = %v", out)
	}
	if strings.Join(in, ",") != "c,a,b" {
		t.Fatalf("sortedStrings mutated its input: %v", in)
	}
	if got := sortedStrings(nil); len(got) != 0 {
		t.Fatalf("sortedStrings(nil) = %v, want empty", got)
	}
}
