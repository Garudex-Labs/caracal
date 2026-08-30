// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestNamespaceSlugParts(t *testing.T) {
	cases := []struct {
		in       string
		ns, slug string
		ok       bool
	}{
		{"acme/weather", "acme", "weather", true},
		{" ACME/Weather ", "acme", "weather", true},
		{"weather", "", "", false},
		{"a/b/c", "", "", false},
		{"a/slug", "", "", false},          // namespace too short
		{"acme/UPPER SLUG", "", "", false}, // space survives lowering and fails
		{"a..b/slug", "", "", false},
		{"acme/", "", "", false},
	}
	for _, c := range cases {
		ns, slug, ok := namespaceSlugParts(c.in)
		if ns != c.ns || slug != c.slug || ok != c.ok {
			t.Errorf("namespaceSlugParts(%q) = (%q, %q, %v), want (%q, %q, %v)",
				c.in, ns, slug, ok, c.ns, c.slug, c.ok)
		}
	}
}

func TestResolveQualifiedNameBindsNamespaceAndSlug(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(nil)}}
	s := &Store{DB: db}
	row, err := s.Resolve(context.Background(), Families["mcps"], "acme/weather", testViewer("user"), false)
	if err != nil || row == nil {
		t.Fatalf("resolve: %v, row=%v", err, row)
	}
	if len(db.log) != 1 || !strings.Contains(db.log[0], "l.namespace = $1") || !strings.Contains(db.log[0], "l.slug = $2") {
		t.Errorf("qualified-name predicates missing:\n%v", db.log)
	}
}

func TestShowFallsBackToUnapprovedForOwner(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		// Order matters: the approved-only pass must answer empty first.
		{match: "v.status = 'approved'", rows: &fakeRows{}},
		mcpShowStub(map[string]any{"status": "pending"}),
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/"+listingUUID, "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var doc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("body: %v", err)
	}
	if doc["status"] != "pending" || doc["user_permission"] != "owner" {
		t.Errorf("fallback detail: status=%v permission=%v", doc["status"], doc["user_permission"])
	}
}

func TestShowHidesUnapprovedFromOutsiders(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "v.status = 'approved'", rows: &fakeRows{}},
		mcpShowStub(map[string]any{"status": "pending", "submitted_by": otherUserID}),
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/"+listingUUID, "user")
	if rec.Code != http.StatusNotFound {
		t.Errorf("outsider: status = %d: %s", rec.Code, rec.Body.String())
	}

	// A reviewer may see the same unapproved row.
	reviewer := &fakeDB{stubs: []stub{
		{match: "v.status = 'approved'", rows: &fakeRows{}},
		mcpShowStub(map[string]any{"status": "pending", "submitted_by": otherUserID}),
	}}
	rec = serveRegistry(t, reviewer, http.MethodGet, "/api/v1/mcps/"+listingUUID, "reviewer")
	if rec.Code != http.StatusOK {
		t.Errorf("reviewer: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestShowBareNameAmbiguityConflicts(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM mcp_listings", rows: &fakeRows{cols: mcpShowCols, rows: [][]any{
			mcpShowRow(map[string]any{"namespace": "acme"}),
			mcpShowRow(map[string]any{"namespace": "zulu"}),
		}}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/weather", "user")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "'weather' is ambiguous") ||
		!strings.Contains(body, "acme/weather") || !strings.Contains(body, "zulu/weather") {
		t.Errorf("ambiguity detail: %s", body)
	}
}

func TestShowRendersValidationResults(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM mcp_validation_results", rows: &fakeRows{
			cols: []string{"stage", "passed", "details", "run_at"},
			rows: [][]any{{"clone", true, nil, testNow}},
		}},
		mcpShowStub(nil),
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/"+listingUUID, "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var doc struct {
		ValidationResults []map[string]any `json:"validation_results"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(doc.ValidationResults) != 1 || doc.ValidationResults[0]["stage"] != "clone" ||
		doc.ValidationResults[0]["passed"] != true {
		t.Errorf("validation results: %v", doc.ValidationResults)
	}
}

func TestShowRejectsPathWithSlash(t *testing.T) {
	rec := serveRegistry(t, &fakeDB{}, http.MethodGet, "/api/v1/mcps/acme%2Fweather", "user")
	if rec.Code != http.StatusNotFound {
		t.Errorf("encoded slash: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestResolveEndpointAnswersComponentIdentity(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(nil)}}
	rec := serveRegistry(t, db, http.MethodGet,
		"/api/v1/registry/resolve?type=mcp&identifier="+listingUUID, "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var doc registryResolution
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("body: %v", err)
	}
	if doc.Type != "mcp" || doc.QualifiedName != "acme/weather" || doc.ID != listingUUID {
		t.Errorf("resolution: %+v", doc)
	}
}

func TestResolveEndpointValidatesParams(t *testing.T) {
	cases := []string{
		"/api/v1/registry/resolve",                                                 // both missing
		"/api/v1/registry/resolve?type=widget&identifier=x",                        // bad type
		"/api/v1/registry/resolve?type=mcp&identifier=",                            // too short
		"/api/v1/registry/resolve?type=mcp&identifier=" + strings.Repeat("a", 130), // too long
	}
	for _, target := range cases {
		rec := serveRegistry(t, &fakeDB{}, http.MethodGet, target, "user")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d", target, rec.Code)
		}
	}
}

func TestResolveEndpointComponentNotFound(t *testing.T) {
	rec := serveRegistry(t, &fakeDB{}, http.MethodGet,
		"/api/v1/registry/resolve?type=skill&identifier="+listingUUID, "user")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Skill not found") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}
