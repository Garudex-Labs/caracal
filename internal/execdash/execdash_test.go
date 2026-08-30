// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package execdash

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReplaceProjectScope(t *testing.T) {
	in := "WHERE project_id = '{project_id}' AND x AND project_id = '{project_id}'"
	want := "WHERE project_id = 'default' AND x AND project_id = 'default'"
	if got := replaceProjectScope(in); got != want {
		t.Errorf("got %s", got)
	}
}

func TestRound1TiesToEven(t *testing.T) {
	cases := map[float64]float64{33.35: 33.4, 0.25: 0.2, 50.0: 50.0, 66.666: 66.7}
	for in, want := range cases {
		if got := round1(in); got != want {
			t.Errorf("round1(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestFloatNumberWire(t *testing.T) {
	if floatNumber(75) != "75.0" || floatNumber(33.4) != "33.4" {
		t.Errorf("floatNumber: %s %s", floatNumber(75), floatNumber(33.4))
	}
}

func TestChInt(t *testing.T) {
	if chInt(map[string]any{"cnt": "42"}, "cnt") != 42 || chInt(map[string]any{"cnt": 7.0}, "cnt") != 7 {
		t.Error("chInt conversions")
	}
}

func TestGenerateRouteMounted(t *testing.T) {
	h := &Handler{Store: &Store{}}
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, httptest.NewRequest("PATCH", "/api/v1/exec/ai-insights", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("unexpected method should be rejected: %d", rec.Code)
	}
}

func TestTrendPercent(t *testing.T) {
	cases := []struct {
		current, previous int64
		want              float64
	}{{10, 0, 100.0}, {0, 0, 0.0}, {15, 10, 50.0}, {5, 10, -50.0}, {7, 3, 133.3}}
	for _, tc := range cases {
		if got := trendPercent(tc.current, tc.previous); got != tc.want {
			t.Errorf("trendPercent(%d,%d) = %v, want %v", tc.current, tc.previous, tc.want, got)
		}
	}
}

func TestDaysParam(t *testing.T) {
	for query, want := range map[string]int{"": 7, "range=24h": 1, "range=90d": 90, "range=zz": 7} {
		req := httptest.NewRequest("GET", "/api/v1/exec/usage-by-category?"+query, nil)
		if got := days(req); got != want {
			t.Errorf("days(%q) = %d", query, got)
		}
	}
}

func TestLimitParamBounds(t *testing.T) {
	ok := map[string]int{"": 10, "limit=25": 25, "limit=50": 50}
	for query, want := range ok {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/x?"+query, nil)
		got, valid := limitParam(rec, req, 10, 50)
		if !valid || got != want {
			t.Errorf("limitParam(%q) = %d,%v want %d,true", query, got, valid, want)
		}
	}
	for _, query := range []string{"limit=51", "limit=0", "limit=-1", "limit=abc"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/x?"+query, nil)
		if _, valid := limitParam(rec, req, 10, 50); valid || rec.Code != 422 {
			t.Errorf("limitParam(%q) accepted invalid input: code=%d", query, rec.Code)
		}
	}
}
