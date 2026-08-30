// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package support

import (
	"testing"
	"time"

	"github.com/garudex-labs/caracal/internal/logring"
)

func TestParseDuration(t *testing.T) {
	cases := []struct {
		in   string
		want time.Duration
	}{
		{"1h", time.Hour},
		{"30m", 30 * time.Minute},
		{"2d", 48 * time.Hour},
		{"1h30m", 90 * time.Minute},
		{"90s", 90 * time.Second},
		{"garbage", time.Hour},
		{"", time.Hour},
		{"0s", time.Hour},
	}
	for _, tc := range cases {
		if got := parseDuration(tc.in); got != tc.want {
			t.Errorf("parseDuration(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestRateWindow(t *testing.T) {
	h := &Handler{}
	for i := 0; i < 5; i++ {
		if !h.allow("actor") {
			t.Fatalf("request %d unexpectedly limited", i+1)
		}
	}
	if h.allow("actor") {
		t.Fatal("sixth request should be limited")
	}
	if !h.allow("other") {
		t.Fatal("distinct actor should not be limited")
	}
}

func TestCollectLogsFiltersAndRedacts(t *testing.T) {
	ring := &logring.Ring{}
	now := time.Now().UTC()
	ring.Append(logring.Entry{
		Timestamp: now.Add(-2 * time.Hour).Format("2006-01-02T15:04:05.000000Z"),
		Level:     "INFO", Event: "old entry",
	})
	ring.Append(logring.Entry{
		Timestamp: now.Add(-5 * time.Minute).Format("2006-01-02T15:04:05.000000Z"),
		Level:     "INFO", Event: "token=sk-abcdef1234567890abcdef fresh",
	})
	h := &Handler{Ring: ring}
	out := h.collectLogs("1h")
	lines := out["lines"].([]map[string]any)
	if len(lines) != 1 {
		t.Fatalf("lines = %d, want 1", len(lines))
	}
	event := lines[0]["event"].(string)
	if event == "token=sk-abcdef1234567890abcdef fresh" {
		t.Fatal("secret was not redacted")
	}
	if _, hasNote := out["note"]; hasNote {
		t.Fatal("note should be absent when lines exist")
	}
	empty := h.collectLogs("1s")
	if empty["note"] != "Log buffer empty or server recently restarted" {
		t.Fatalf("note = %v", empty["note"])
	}
}

func TestCollectorSelection(t *testing.T) {
	if !contains([]string{"all"}, "all") {
		t.Fatal("contains failed")
	}
	if contains([]string{"health"}, "logs") {
		t.Fatal("contains false positive")
	}
}
