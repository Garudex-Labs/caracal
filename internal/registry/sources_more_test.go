// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// sourceCols matches sourceColumns aliases in the RETURNING/SELECT lists.
var sourceCols = []string{
	"id", "url", "provider", "component_type", "is_public",
	"project_id", "auto_sync_interval", "last_synced_at", "sync_status",
	"sync_error", "created_at",
}

func sourceRow(id, url string, isPublic bool, projectID any) []any {
	return []any{
		id, url, "github", "mcp", isPublic,
		projectID, nil, testNow, "success",
		nil, testNow,
	}
}

func TestDetectProviderByURL(t *testing.T) {
	cases := map[string]string{
		"https://github.com/acme/x":      "github",
		"https://gitlab.com/acme/x":      "gitlab",
		"https://bitbucket.org/acme/x":   "bitbucket",
		"https://example.com/acme/x.git": "github",
		"git@GITLAB.com:acme/x.git":      "gitlab",
	}
	for url, want := range cases {
		if got := detectProvider(url); got != want {
			t.Errorf("detectProvider(%q) = %q, want %q", url, got, want)
		}
	}
}

func TestIsoDurationRendersInterval(t *testing.T) {
	if got := isoDuration(90 * time.Second); got == nil || *got != "PT90S" {
		t.Errorf("isoDuration(90s) = %v", got)
	}
	if got := isoDuration("not-a-duration"); got != nil {
		t.Errorf("isoDuration(non-duration) = %v, want nil", got)
	}
	if got := isoDuration(nil); got != nil {
		t.Errorf("isoDuration(nil) = %v, want nil", got)
	}
}

func TestSourceWireOfMapsRow(t *testing.T) {
	pub := sourceWireOf(map[string]any{
		"id": "abc", "url": "https://github.com/a/b", "provider": "github",
		"component_type": "mcp", "is_public": true, "created_at": testNow,
	})
	if pub.Visibility != "public" || pub.ID != "abc" || pub.Provider != "github" {
		t.Errorf("public wire = %+v", pub)
	}
	if pub.CreatedAt != "2026-08-30T08:00:00Z" {
		t.Errorf("created_at = %v", pub.CreatedAt)
	}

	proj := sourceWireOf(map[string]any{"is_public": false, "project_id": "p1"})
	if proj.Visibility != "project" || proj.ProjectID == nil || *proj.ProjectID != "p1" {
		t.Errorf("project wire = %+v", proj)
	}
}

func TestListSourcesEndpoint(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM component_sources", rows: &fakeRows{cols: sourceCols, rows: [][]any{
			sourceRow("11111111-1111-1111-1111-111111111111", "https://github.com/a/b", true, nil),
		}}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/component-sources?component_type=mcp", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if len(out) != 1 || out[0]["provider"] != "github" || out[0]["visibility"] != "public" {
		t.Errorf("sources = %v", out)
	}
	// The component_type filter must reach the query as a bound predicate.
	joined := strings.Join(db.log, "\n")
	if !strings.Contains(joined, "component_type = $1") {
		t.Errorf("component_type filter not applied: %v", db.log)
	}
}

func TestListSourcesStorageFailureIs500(t *testing.T) {
	db := &fakeDB{stubs: []stub{{match: "FROM component_sources", err: errBoom}}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/component-sources", "user")
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "boom") {
		t.Errorf("internal detail leaked: %s", rec.Body.String())
	}
}

func TestGetSourceEndpoint(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"

	// Public source: visible to any signed-in caller.
	db := &fakeDB{stubs: []stub{
		{match: "FROM component_sources", rows: &fakeRows{cols: sourceCols, rows: [][]any{
			sourceRow(id, "https://github.com/a/b", true, nil),
		}}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/component-sources/"+id, "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("public source: status = %d: %s", rec.Code, rec.Body.String())
	}

	// Unknown source: 404.
	rec = serveRegistry(t, &fakeDB{}, http.MethodGet, "/api/v1/component-sources/"+id, "user")
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing source: status = %d", rec.Code)
	}

	// Malformed UUID: 422.
	rec = serveRegistry(t, &fakeDB{}, http.MethodGet, "/api/v1/component-sources/not-a-uuid", "user")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("malformed id: status = %d", rec.Code)
	}
}

func TestGetSourcePrivateHiddenFromNonMember(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"
	db := &fakeDB{stubs: []stub{
		{match: "FROM component_sources", rows: &fakeRows{cols: sourceCols, rows: [][]any{
			sourceRow(id, "https://github.com/a/b", false, "99999999-9999-9999-9999-999999999999"),
		}}},
		// No project_memberships row: not a member.
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/component-sources/"+id, "user")
	if rec.Code != http.StatusNotFound {
		t.Errorf("private source hidden: status = %d, want 404", rec.Code)
	}
}

func TestDeleteSourceEndpoint(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"

	// Unknown source: 404.
	rec := serveRegistry(t, &fakeDB{}, http.MethodDelete, "/api/v1/component-sources/"+id, "user")
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing source: status = %d", rec.Code)
	}

	// Public source, ordinary user without project lead: 403.
	pub := &fakeDB{stubs: []stub{
		{match: "FROM component_sources", rows: &fakeRows{cols: sourceCols, rows: [][]any{
			sourceRow(id, "https://github.com/a/b", true, nil),
		}}},
	}}
	rec = serveRegistry(t, pub, http.MethodDelete, "/api/v1/component-sources/"+id, "user")
	if rec.Code != http.StatusForbidden {
		t.Errorf("non-lead delete: status = %d, want 403", rec.Code)
	}

	// Operator deletes any source.
	rec = serveRegistry(t, pub, http.MethodDelete, "/api/v1/component-sources/"+id, "operator")
	if rec.Code != http.StatusOK {
		t.Errorf("operator delete: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestDeleteSourceProjectLeadAllowed(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"
	pid := "99999999-9999-9999-9999-999999999999"
	db := &fakeDB{stubs: []stub{
		{match: "FROM component_sources", rows: &fakeRows{cols: sourceCols, rows: [][]any{
			sourceRow(id, "https://github.com/a/b", false, pid),
		}}},
		// sourceVisible membership probe.
		{match: "user_id FROM project_memberships", rows: &fakeRows{
			cols: []string{"user_id"}, rows: [][]any{{"22222222-2222-2222-2222-222222222222"}}}},
		// ProjectRole lookup grants lead.
		{match: "role FROM project_memberships", rows: &fakeRows{
			cols: []string{"role"}, rows: [][]any{{"lead"}}}},
	}}
	rec := serveRegistry(t, db, http.MethodDelete, "/api/v1/component-sources/"+id, "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("lead delete: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAddSourceValidation(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"missing url", `{"component_type":"mcp"}`},
		{"short url", `{"url":"https://x","component_type":"mcp"}`},
		{"non-https url", `{"url":"http://github.com/a/b","component_type":"mcp"}`},
		{"missing type", `{"url":"https://github.com/a/b"}`},
		{"bad type", `{"url":"https://github.com/a/b","component_type":"widget"}`},
		{"agent type", `{"url":"https://github.com/a/b","component_type":"agent"}`},
	}
	for _, tc := range cases {
		db := &fakeDB{}
		rec := serveRegistryReq(t, db, http.MethodPost, "/api/v1/component-sources", "user", strings.NewReader(tc.body))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422: %s", tc.name, rec.Code, rec.Body.String())
		}
		if len(db.log) != 0 {
			t.Errorf("%s: invalid body must not reach the DB: %v", tc.name, db.log)
		}
	}
}

func TestAddSourceEmptyBodyIs422(t *testing.T) {
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost, "/api/v1/component-sources", "user", strings.NewReader(""))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("empty body: status = %d, want 422", rec.Code)
	}
	rec = serveRegistryReq(t, &fakeDB{}, http.MethodPost, "/api/v1/component-sources", "user", strings.NewReader("{not json"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("invalid json: status = %d, want 422", rec.Code)
	}
}

func TestAddSourceHappyPath(t *testing.T) {
	newID := "44444444-4444-4444-4444-444444444444"
	db := &fakeDB{stubs: []stub{
		{match: "FROM users WHERE id", rows: &fakeRows{
			cols: []string{"username", "email"}, rows: [][]any{{"acme", "a@b.co"}}}},
		{match: "FROM organizations ORDER BY created_at", rows: &fakeRows{
			cols: []string{"id"}, rows: [][]any{{"55555555-5555-5555-5555-555555555555"}}}},
		{match: "FROM projects WHERE organization_id", rows: &fakeRows{
			cols: []string{"id"}, rows: [][]any{{"66666666-6666-6666-6666-666666666666"}}}},
		{match: "INSERT INTO component_sources", rows: &fakeRows{cols: sourceCols, rows: [][]any{
			sourceRow(newID, "https://github.com/a/b", true, nil),
		}}},
	}}
	rec := serveRegistryReq(t, db, http.MethodPost, "/api/v1/component-sources", "user",
		strings.NewReader(`{"url":"https://github.com/a/b","component_type":"mcp","visibility":"public"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body: %v", err)
	}
	if out["id"] != newID || out["provider"] != "github" {
		t.Errorf("created source = %v", out)
	}
}
