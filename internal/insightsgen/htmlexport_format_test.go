// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestHxEscapePreventsMarkupInjection(t *testing.T) {
	got := hxEscape(`<script>alert("x") & 'y'</script>`)
	for _, banned := range []string{"<", ">", `"`, "'"} {
		if strings.Contains(got, banned) {
			t.Errorf("escape left %q in %q", banned, got)
		}
	}
	if !strings.Contains(got, "&lt;script&gt;") {
		t.Errorf("escaped form: %q", got)
	}
}

func TestHxTextScalarForms(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{nil, "None"},
		{"plain", "plain"},
		{[]byte("bytes"), "bytes"},
		{true, "True"},
		{false, "False"},
		{float64(3), "3"},
		{float64(3.5), "3.5"},
		{int(7), "7"},
		{int64(9), "9"},
		{json.Number("12.25"), "12.25"},
		{time.Date(2026, 8, 30, 9, 30, 0, 0, time.UTC), "2026-08-30 09:30:00"},
	}
	for _, tc := range cases {
		if got := hxText(tc.in); got != tc.want {
			t.Errorf("hxText(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestHxEscRendersFalsyEmpty(t *testing.T) {
	for _, v := range []any{nil, "", float64(0), false, map[string]any{}, []any{}} {
		if got := hxEsc(v); got != "" {
			t.Errorf("hxEsc(%v) = %q, want empty", v, got)
		}
	}
	if got := hxEsc("<b>"); got != "&lt;b&gt;" {
		t.Errorf("hxEsc = %q", got)
	}
}

func TestHxNumAndFloatText(t *testing.T) {
	if got := hxNumText(1500); got != "1500" {
		t.Errorf("whole float: %q", got)
	}
	if got := hxNumText(2.75); got != "2.75" {
		t.Errorf("fraction: %q", got)
	}
	if got := hxFloatText(3); got != "3.0" {
		t.Errorf("float marker: %q", got)
	}
	if got := hxFloatText(2.5); got != "2.5" {
		t.Errorf("existing fraction: %q", got)
	}
}

func TestHxGroupThousands(t *testing.T) {
	cases := map[string]string{
		"123":         "123",
		"1234":        "1,234",
		"1234567":     "1,234,567",
		"-1234567.89": "-1,234,567.89",
		"12.5":        "12.5",
	}
	for in, want := range cases {
		if got := hxGroup(in); got != want {
			t.Errorf("hxGroup(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHxCostPrecisionSwitches(t *testing.T) {
	if got := hxCost(float64(12.3456)); got != "$12.35" {
		t.Errorf("normal cost: %q", got)
	}
	if got := hxCost(float64(0.0042)); got != "$0.0042" {
		t.Errorf("sub-cent cost keeps precision: %q", got)
	}
	if got := hxCost("not a number"); got != "$0.00" {
		t.Errorf("non-numeric: %q", got)
	}
}

func TestHxTokensAbbreviation(t *testing.T) {
	if got := hxTokensF(2_500_000); got != "2.5M" {
		t.Errorf("millions: %q", got)
	}
	if got := hxTokensF(45_000); got != "45k" {
		t.Errorf("thousands: %q", got)
	}
	if got := hxTokensF(999); got != "999" {
		t.Errorf("small: %q", got)
	}
}

func TestHxPeriodDisplayTruncatesTimestamps(t *testing.T) {
	if got := hxPeriodDisplay("2026-08-30T09:00:00Z"); got != "2026-08-30" {
		t.Errorf("string timestamp: %v", got)
	}
	if got := hxPeriodDisplay(time.Date(2026, 8, 30, 9, 0, 0, 0, time.UTC)); got != "2026-08-30" {
		t.Errorf("time value: %v", got)
	}
	if got := hxPeriodDisplay(42); got != 42 {
		t.Errorf("passthrough: %v", got)
	}
}

func TestHxColorScales(t *testing.T) {
	if hxSeverityColor("high") == hxSeverityColor("low") {
		t.Error("severity colors must differ")
	}
	if got := hxSeverityColor("unknown"); got != "#6b7280" {
		t.Errorf("unknown severity: %q", got)
	}
	// Priority low is positive (green), severity low is informational (blue).
	if hxPriorityColor("low") == hxSeverityColor("low") {
		t.Error("priority and severity low must differ")
	}
}

func TestHxHealthBadgeEscapesAndUppercases(t *testing.T) {
	got := hxHealthBadge("healthy")
	if !strings.Contains(got, "HEALTHY") || !strings.Contains(got, "#16a34a") {
		t.Errorf("healthy badge: %q", got)
	}
	injected := hxHealthBadge(`<img onerror=x>`)
	if strings.Contains(injected, "<img") {
		t.Errorf("badge did not escape input: %q", injected)
	}
}

func TestHxSortedKVDescOrdersByValueThenKeyShape(t *testing.T) {
	kvs := hxSortedKVDesc(map[string]any{
		"bb": float64(1), "a": float64(1), "big": float64(9), "ccc": float64(1),
	})
	gotKeys := make([]string, len(kvs))
	for i, kv := range kvs {
		gotKeys[i] = kv.key
	}
	want := []string{"big", "a", "bb", "ccc"}
	if strings.Join(gotKeys, ",") != strings.Join(want, ",") {
		t.Errorf("order = %v, want %v", gotKeys, want)
	}
}

func TestHxChartBuilders(t *testing.T) {
	items := hxKVItems(hxSortedKVDesc(map[string]any{"read": float64(30), "write": float64(10)}), 5)
	chart := hxCountBarChart(items, "#123456")
	if !strings.Contains(chart, "read") || !strings.Contains(chart, "width:100.0%") {
		t.Errorf("count chart scales to the max:\n%s", chart)
	}
	if !strings.Contains(chart, "width:33.3%") {
		t.Errorf("count chart proportional width:\n%s", chart)
	}
	if hxCountBarChart(nil, "#000") != "" {
		t.Error("empty items must render nothing")
	}

	pct := hxPctBarChart([]hxItem{{label: "adoption", value: 62.5}}, "#abc")
	if !strings.Contains(pct, "width:62.5%") || !strings.Contains(pct, "62%") {
		t.Errorf("pct chart:\n%s", pct)
	}
}

func TestHxPairItemsReadsLabelValueRows(t *testing.T) {
	items := hxPairItems([]any{
		[]any{"alpha", float64(3)},
		[]any{"broken"},
		[]any{"beta", "7"},
	}, 5)
	// Non-numeric values keep the row at zero rather than dropping it.
	if len(items) != 2 || items[0].label != "alpha" || items[1].value != 0 {
		t.Errorf("pair items: %+v", items)
	}
}

func TestHxCoercions(t *testing.T) {
	if m := hxMapOf([]byte(`{"a": 1}`)); m["a"] == nil {
		t.Errorf("hxMapOf raw JSON: %v", m)
	}
	if m := hxMapOf("junk"); len(m) != 0 {
		t.Errorf("hxMapOf junk: %v", m)
	}
	if l := hxListOf([]byte(`[1, 2]`)); len(l) != 2 {
		t.Errorf("hxListOf raw JSON: %v", l)
	}
	if n, ok := hxNumeric(json.Number("4.5")); !ok || n != 4.5 {
		t.Errorf("hxNumeric json.Number: %v %v", n, ok)
	}
	// Strings are never numerically coerced, even when they look numeric.
	if _, ok := hxNumeric("12"); ok {
		t.Error("hxNumeric must not coerce strings")
	}
	if got := hxOrValue(nil, "fallback"); got != "fallback" {
		t.Errorf("hxOrValue: %v", got)
	}
	if got := hxOrValue("set", "fallback"); got != "set" {
		t.Errorf("hxOrValue: %v", got)
	}
}
