// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/registry"
)

var installVersionCols = []string{
	"id", "version", "description", "prompt",
	"model_name", "models_by_harness", "external_mcps", "required_capabilities",
}

func installVersionRow() []any {
	return []any{
		versionID, "1.0.0", "reviews code", "You review code.",
		"claude-sonnet-4-5", map[string]any{}, []any{}, []any{},
	}
}

// TestInstallListingsPinsExactVersion proves a concrete resolved_version overlays
// the component's latest release, so a historical agent version reproduces the
// exact dependency graph it was released against.
func TestInstallListingsPinsExactVersion(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "l.latest_version_id = v.id", rows: &fakeRows{
			cols: []string{"id", "name", "command"},
			rows: [][]any{{mcpListingID, "weather", "latest-command"}}}},
		{match: "v.listing_id = l.id AND v.version =", rows: &fakeRows{
			cols: []string{"id", "name", "command"},
			rows: [][]any{{mcpListingID, "weather", "pinned-command"}}}},
	}}
	s := &Store{DB: db}
	out, err := s.installListings(context.Background(), "mcp", []string{mcpListingID},
		&registry.Viewer{Role: "operator"}, "", map[string]string{mcpListingID: "1.2.0"})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := out[mcpListingID]["command"].(string); got != "pinned-command" {
		t.Fatalf("expected the pinned version to overlay latest, got command=%q", got)
	}
	pinnedQueried := false
	for _, q := range db.log {
		if strings.Contains(q, "v.listing_id = l.id AND v.version =") {
			pinnedQueried = true
		}
	}
	if !pinnedQueried {
		t.Error("pinned-version query was never issued")
	}
}

// TestInstallListingsLatestPinSkipsOverlay confirms a "latest" pin keeps the
// existing latest path and issues no extra version query.
func TestInstallListingsLatestPinSkipsOverlay(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "l.latest_version_id = v.id", rows: &fakeRows{
			cols: []string{"id", "name", "command"},
			rows: [][]any{{mcpListingID, "weather", "latest-command"}}}},
	}}
	s := &Store{DB: db}
	out, err := s.installListings(context.Background(), "mcp", []string{mcpListingID},
		&registry.Viewer{Role: "operator"}, "", map[string]string{mcpListingID: "latest"})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := out[mcpListingID]["command"].(string); got != "latest-command" {
		t.Fatalf("latest pin must use the latest listing, got command=%q", got)
	}
	for _, q := range db.log {
		if strings.Contains(q, "v.listing_id = l.id AND v.version =") {
			t.Error("latest pin must not issue a pinned-version query")
		}
	}
}

func TestInstallValidatesBody(t *testing.T) {
	db := &fakeDB{}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/install", "user", "{}")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing harness: status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Field required") {
		t.Errorf("detail: %s", rec.Body.String())
	}

	rec = serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/install", "user", "[]")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("malformed body: status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "model_attributes_type") {
		t.Errorf("detail: %s", rec.Body.String())
	}
	if len(db.log) != 0 {
		t.Errorf("invalid body reached the database: %v", db.log)
	}
}

func TestInstallGeneratesConfigForLatestVersion(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "WHERE v.id = $1", rows: &fakeRows{cols: installVersionCols, rows: [][]any{installVersionRow()}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/install", "user",
		`{"harness": "kiro"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d["agent_id"] != agentID || d["harness"] != "kiro" || d["config_snippet"] == nil {
		t.Errorf("install response: %v", d)
	}
	recorded := false
	for _, sql := range db.log {
		if strings.Contains(sql, "INSERT INTO agent_download_records") {
			recorded = true
		}
	}
	if !recorded {
		t.Errorf("download not recorded: %v", db.log)
	}
}

func TestInstallUnknownVersionIs404(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/install", "user",
		`{"harness": "kiro", "version": "9.9.9"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Version '9.9.9' not found or not approved") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestInstallWithoutPublishedVersionIs400(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"latest_version_id": nil}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/install", "user",
		`{"harness": "kiro"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no published version") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestInstallUnapprovedAgentIs404(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"status": "pending"}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/install", "user",
		`{"harness": "kiro"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "not approved for installation") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestAnySlice(t *testing.T) {
	if got := anySlice([]any{"a", 1}); len(got) != 2 {
		t.Errorf("[]any passthrough: %v", got)
	}
	if got := anySlice([]string{"a", "b"}); len(got) != 2 || got[0] != "a" {
		t.Errorf("[]string conversion: %v", got)
	}
	if got := anySlice(42); got != nil {
		t.Errorf("non-slice: %v", got)
	}
}
