// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

var testNow = time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)

// listingCols matches selectColumns for mcps.
var listingCols = []string{
	"id", "name", "namespace", "slug", "owner", "project_id",
	"is_private", "ownership_scope", "updated_at", "created_at",
	"version", "description", "status", "rejection_reason", "supported_harnesses",
	"category",
}

func listingRow(id, name, slug string) []any {
	return []any{
		id, name, "acme", slug, "acme-team", nil,
		false, "user", testNow, testNow,
		"1.2.0", "a component", "approved", nil, []any{"kiro"},
		"general",
	}
}

// serveRegistry mounts the handler over a fake DB and issues one request.
func serveRegistry(t *testing.T, db *fakeDB, method, target, role string) *httptest.ResponseRecorder {
	t.Helper()
	h := &Handler{Store: &Store{DB: db}}
	mux := http.NewServeMux()
	withClaims := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{
				UserID: uuid.MustParse("22222222-2222-2222-2222-222222222222"),
				Role:   role,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	h.Register(mux, withClaims)
	req := httptest.NewRequest(method, target, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestListEndpointRendersSummaries(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "count(", rows: &fakeRows{cols: []string{"count"}, rows: [][]any{{int64(2)}}}},
		{match: "FROM mcp_listings", rows: &fakeRows{cols: listingCols, rows: [][]any{
			listingRow("11111111-1111-1111-1111-111111111111", "Weather", "weather"),
			listingRow("33333333-3333-3333-3333-333333333333", "Mailer", "mailer"),
		}}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var items []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if len(items) != 2 {
		t.Fatalf("items = %d", len(items))
	}
	first := items[0]
	if first["qualified_name"] != "acme/weather" || first["visibility"] != "public" {
		t.Errorf("summary fields: %v", first)
	}
	if first["updated_at"] != "2026-08-30T08:00:00Z" {
		t.Errorf("updated_at = %v", first["updated_at"])
	}
}

func TestListEndpointValidatesParams(t *testing.T) {
	db := &fakeDB{}
	cases := []string{
		"/api/v1/mcps?limit=0",
		"/api/v1/mcps?limit=doom",
		"/api/v1/mcps?limit=1000",
		"/api/v1/mcps?composable_for_project_id=not-a-uuid",
		"/api/v1/mcps?public_only=perhaps",
	}
	for _, target := range cases {
		rec := serveRegistry(t, db, http.MethodGet, target, "user")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422", target, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `"detail"`) {
			t.Errorf("%s: no detail body: %s", target, rec.Body.String())
		}
	}
	if len(db.log) != 0 {
		t.Errorf("invalid params must not reach the database: %v", db.log)
	}
}

func TestShowEndpointRendersDetailAnd404(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"
	db := &fakeDB{stubs: []stub{
		{match: "FROM mcp_listings", rows: &fakeRows{cols: listingCols, rows: [][]any{
			listingRow(id, "Weather", "weather"),
		}}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/"+id, "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"Weather"`) {
		t.Errorf("detail body: %s", rec.Body.String())
	}

	empty := &fakeDB{}
	rec = serveRegistry(t, empty, http.MethodGet, "/api/v1/mcps/"+id, "user")
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing listing: status = %d", rec.Code)
	}
}

func TestShowEndpointRejectsMalformedUUID(t *testing.T) {
	rec := serveRegistry(t, &fakeDB{}, http.MethodGet, "/api/v1/mcps/not-a-uuid", "user")
	if rec.Code != http.StatusUnprocessableEntity && rec.Code != http.StatusNotFound {
		t.Errorf("malformed id: status = %d", rec.Code)
	}
}

func TestListStorageFailureIs500(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "count(", err: errBoom},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps", "user")
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("storage failure: status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "boom") {
		t.Errorf("internal error detail leaked: %s", rec.Body.String())
	}
}

var errBoom = &pgError{"boom"}

type pgError struct{ msg string }

func (e *pgError) Error() string { return e.msg }
