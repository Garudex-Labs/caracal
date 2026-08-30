// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package overview

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

func TestVisibilityClause(t *testing.T) {
	args := []any{}
	if got := visibilityClause("l", "l.submitted_by", nil, &args); got != "l.is_private = FALSE" {
		t.Errorf("anonymous = %s", got)
	}
	operator := &Viewer{ID: uuid.New(), Role: "operator"}
	if got := visibilityClause("l", "l.submitted_by", operator, &args); got == "TRUE" {
		t.Errorf("operator must not bypass private visibility: %s", got)
	}
	user := &Viewer{ID: uuid.New(), Role: "user"}
	args = []any{}
	clause := visibilityClause("a", "a.created_by", user, &args)
	for _, frag := range []string{
		"a.is_private = FALSE",
		"a.created_by = $1",
		"a.ownership_scope = 'private' OR a.project_id IS NULL",
		"project_memberships",
		"a.ownership_scope != 'private'",
	} {
		if !strings.Contains(clause, frag) {
			t.Errorf("missing %q in %s", frag, clause)
		}
	}
	if len(args) != 1 || args[0] != user.ID {
		t.Errorf("args = %v", args)
	}
}

func TestFloatNumber(t *testing.T) {
	if floatNumber(3) != "3.0" || floatNumber(4.25) != "4.25" {
		t.Errorf("floatNumber: %s %s", floatNumber(3), floatNumber(4.25))
	}
}

func TestDays(t *testing.T) {
	for query, want := range map[string]int{"": 7, "range=24h": 1, "range=30d": 30, "range=bogus": 7} {
		req := httptest.NewRequest("GET", "/api/v1/overview/stats?"+query, nil)
		if got := days(req); got != want {
			t.Errorf("days(%q) = %d, want %d", query, got, want)
		}
	}
}

func TestTrendsRequiresOperator(t *testing.T) {
	h := &Handler{Store: &Store{}}
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	res, err := srv.Client().Get(srv.URL + "/api/v1/overview/trends")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if res.StatusCode != 401 || !strings.Contains(string(body), "Missing credentials") {
		t.Fatalf("anonymous trends = %d %s", res.StatusCode, body)
	}

	req := httptest.NewRequest("GET", srv.URL+"/api/v1/overview/trends", nil)
	req = req.WithContext(httpapi.ContextWithClaims(context.Background(), auth.Claims{UserID: uuid.New(), Role: "user"}))
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "Insufficient permissions") {
		t.Fatalf("user trends = %d %s", rec.Code, rec.Body.String())
	}
}

func TestTopAgentsLimitValidation(t *testing.T) {
	h := &Handler{Store: &Store{}}
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/overview/top-agents?limit=99", nil))
	var body struct {
		Detail []map[string]any `json:"detail"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 422 || len(body.Detail) != 1 || body.Detail[0]["type"] != "less_than_equal" {
		t.Fatalf("limit=99: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/overview/top-agents?limit=abc", nil))
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 422 || body.Detail[0]["type"] != "int_parsing" {
		t.Fatalf("limit=abc: %d %s", rec.Code, rec.Body.String())
	}
	for _, raw := range []string{"limit=-1", "limit=0"} {
		rec = httptest.NewRecorder()
		h.Routes().ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/overview/top-agents?"+raw, nil))
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != 422 || body.Detail[0]["type"] != "greater_than_equal" {
			t.Fatalf("%s: %d %s", raw, rec.Code, rec.Body.String())
		}
	}
}

func TestTrendsMergesAndSorts(t *testing.T) {
	// Exercised via Store.Trends' merge logic with a stub: covered live by
	// the differential; here we pin the sort helper.
	dates := []string{"2026-08-03", "2026-08-01", "2026-08-02"}
	sortStrings(dates)
	if dates[0] != "2026-08-01" || dates[2] != "2026-08-03" {
		t.Errorf("sorted = %v", dates)
	}
	_ = time.Now
}
