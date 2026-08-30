// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// versionCols matches versionColumns for mcps (base + mcp extras resolved at
// runtime; unknown extras simply stay absent from the row map).
var versionCols = []string{
	"id", "listing_id", "version", "description",
	"changelog", "status", "rejection_reason", "download_count",
	"supported_harnesses", "released_by", "released_at", "created_at",
}

func versionRow(id, version, status string) []any {
	return []any{
		id, "11111111-1111-1111-1111-111111111111", version, "a version",
		nil, status, nil, int64(7),
		[]any{"kiro"}, "22222222-2222-2222-2222-222222222222", testNow, testNow,
	}
}

func TestMineEndpointListsOwnSubmissions(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "l.submitted_by", rows: &fakeRows{cols: listingCols, rows: [][]any{
			listingRow("11111111-1111-1111-1111-111111111111", "Weather", "weather"),
		}}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/my", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var items []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil || len(items) != 1 {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if items[0]["qualified_name"] != "acme/weather" {
		t.Errorf("summary: %v", items[0])
	}
}

func TestListVersionsPageEnvelope(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"
	db := &fakeDB{stubs: []stub{
		{match: "count(v.id)", rows: &fakeRows{cols: []string{"count"}, rows: [][]any{{int64(2)}}}},
		{match: "ORDER BY v.released_at", rows: &fakeRows{cols: versionCols, rows: [][]any{
			versionRow("aaaa1111-1111-1111-1111-111111111111", "1.1.0", "approved"),
			versionRow("bbbb1111-1111-1111-1111-111111111111", "1.0.0", "approved"),
		}}},
		{match: "FROM mcp_listings", rows: &fakeRows{cols: listingCols, rows: [][]any{
			listingRow(id, "Weather", "weather"),
		}}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/"+id+"/versions", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var page struct {
		Items    []map[string]any `json:"items"`
		Total    int              `json:"total"`
		Page     int              `json:"page"`
		PageSize int              `json:"page_size"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if page.Total != 2 || len(page.Items) != 2 || page.Page != 1 {
		t.Fatalf("envelope: %+v", page)
	}
	if page.Items[0]["version"] != "1.1.0" || page.Items[0]["download_count"] != float64(7) {
		t.Errorf("version wire: %v", page.Items[0])
	}
}

func TestListVersionsHidesUnapprovedFromOutsiders(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"
	db := &fakeDB{stubs: []stub{
		{match: "count(v.id)", rows: &fakeRows{cols: []string{"count"}, rows: [][]any{{int64(0)}}}},
		{match: "FROM mcp_listings", rows: &fakeRows{cols: listingCols, rows: [][]any{
			listingRow(id, "Weather", "weather"),
		}}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/"+id+"/versions", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	// A plain viewer's count query must carry the approved-only guard.
	found := false
	for _, sql := range db.log {
		if strings.Contains(sql, "count(v.id)") && strings.Contains(sql, "v.status = 'approved'") {
			found = true
		}
	}
	if !found {
		t.Errorf("approved-only filter missing for outsider:\n%v", db.log)
	}
}

func TestGetVersionAnd404(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"
	db := &fakeDB{stubs: []stub{
		{match: "v.version = $2", rows: &fakeRows{cols: versionCols, rows: [][]any{
			versionRow("aaaa1111-1111-1111-1111-111111111111", "1.1.0", "approved"),
		}}},
		{match: "FROM mcp_listings", rows: &fakeRows{cols: listingCols, rows: [][]any{
			listingRow(id, "Weather", "weather"),
		}}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/"+id+"/versions/1.1.0", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"1.1.0"`) {
		t.Errorf("version body: %s", rec.Body.String())
	}

	// Same route with no matching version row is a 404 with the contract detail.
	missing := &fakeDB{stubs: []stub{
		{match: "FROM mcp_listings", rows: &fakeRows{cols: listingCols, rows: [][]any{
			listingRow(id, "Weather", "weather"),
		}}},
	}}
	rec = serveRegistry(t, missing, http.MethodGet, "/api/v1/mcps/"+id+"/versions/9.9.9", "user")
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing version: status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Version not found") {
		t.Errorf("404 detail: %s", rec.Body.String())
	}
}

func TestVersionsForUnknownListingIs404(t *testing.T) {
	rec := serveRegistry(t, &fakeDB{}, http.MethodGet,
		"/api/v1/mcps/11111111-1111-1111-1111-111111111111/versions", "user")
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown listing: status = %d: %s", rec.Code, rec.Body.String())
	}
}
