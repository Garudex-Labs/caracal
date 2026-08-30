// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insights

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeOptional(t *testing.T) {
	type body struct {
		Name string `json:"name"`
	}

	// A nil body is a no-op, leaving the destination untouched.
	var dst body
	req := &http.Request{}
	if err := decodeOptional(req, &dst); err != nil || dst.Name != "" {
		t.Errorf("nil body: dst=%v err=%v", dst, err)
	}

	cases := []struct {
		name    string
		payload string
		want    string
		wantErr bool
	}{
		{"valid", `{"name":"acme"}`, "acme", false},
		{"empty string", "   ", "", false},
		{"literal null", "null", "", false},
		{"invalid json", "{not json", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got body
			r := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(tc.payload))
			err := decodeOptional(r, &got)
			if tc.wantErr != (err != nil) {
				t.Fatalf("err = %v, wantErr = %v", err, tc.wantErr)
			}
			if got.Name != tc.want {
				t.Errorf("name = %q, want %q", got.Name, tc.want)
			}
		})
	}
}

func TestParseSemver(t *testing.T) {
	cases := []struct {
		in   string
		want [3]int
	}{
		{"1.2.3", [3]int{1, 2, 3}},
		{" 10.0.1 ", [3]int{10, 0, 1}}, // surrounding and per-part spaces are trimmed
		{"1.2", [3]int{0, 0, 0}},       // fewer than three parts sorts lowest
		{"1.2.3.4", [3]int{0, 0, 0}},   // SplitN keeps "3.4" as the last part; its atoi fails
		{"a.b.c", [3]int{0, 0, 0}},
		{"-1.0.0", [3]int{0, 0, 0}}, // negatives are rejected
		{"", [3]int{0, 0, 0}},
		{"1.2.notanum", [3]int{0, 0, 0}},
	}
	for _, tc := range cases {
		if got := parseSemver(tc.in); got != tc.want {
			t.Errorf("parseSemver(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestSemverLess(t *testing.T) {
	cases := []struct {
		a, b [3]int
		want bool
	}{
		{[3]int{1, 0, 0}, [3]int{2, 0, 0}, true},
		{[3]int{1, 2, 0}, [3]int{1, 3, 0}, true},
		{[3]int{1, 2, 3}, [3]int{1, 2, 4}, true},
		{[3]int{2, 0, 0}, [3]int{1, 9, 9}, false},
		{[3]int{1, 2, 3}, [3]int{1, 2, 3}, false}, // equal is not less
	}
	for _, tc := range cases {
		if got := semverLess(tc.a, tc.b); got != tc.want {
			t.Errorf("semverLess(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestAgentPatternsAreWellFormed(t *testing.T) {
	patterns := AgentPatterns()
	if len(patterns) != 7 {
		t.Fatalf("pattern count = %d", len(patterns))
	}
	seen := map[string]bool{}
	for _, p := range patterns {
		if seen[p] {
			t.Errorf("duplicate pattern %q", p)
		}
		seen[p] = true
		fields := strings.SplitN(p, " ", 2)
		if len(fields) != 2 {
			t.Errorf("pattern missing method: %q", p)
			continue
		}
		if !strings.HasPrefix(fields[1], "/api/v1/agents/{agent_id}/insights") {
			t.Errorf("pattern off the agent-insights prefix: %q", p)
		}
	}
}

// status with no engine configured reports unavailable rather than erroring.
func TestStatusWithoutEngineIsUnavailable(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/insights/status", nil)
	rec := httptest.NewRecorder()
	h.status(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["available"] != false {
		t.Errorf("available = %v, want false", body["available"])
	}
	if body["reason"] == nil || body["reason"] == "" {
		t.Errorf("unavailable status must carry a reason: %v", body["reason"])
	}
}
