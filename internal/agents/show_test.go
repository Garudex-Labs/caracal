// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/registry"
)

// detailCols mirrors the detailColumns projection in show.go, in order.
var detailCols = []string{
	"id", "name", "namespace", "slug", "owner",
	"project_id", "is_private", "ownership_scope", "co_authors",
	"created_by", "created_at", "updated_at", "deleted_at", "scheduled_purge_at",
	"latest_version_id",
	"version", "description", "prompt", "model_name", "model_config_json",
	"models_by_harness", "external_mcps", "supported_harnesses",
	"required_capabilities", "inferred_supported_harnesses", "success_criteria",
	"status", "rejection_reason",
	"latest_approved_version",
	"created_by_email", "created_by_username",
	"row_visible",
}

const (
	viewerID   = "22222222-2222-2222-2222-222222222222"
	outsiderID = "99999999-9999-9999-9999-999999999999"
	agentID    = "11111111-1111-1111-1111-111111111111"
	versionID  = "33333333-3333-3333-3333-333333333333"
)

// detailRow builds one detail projection row; overrides are keyed by column.
func detailRow(overrides map[string]any) []any {
	row := []any{
		agentID, "Review Bot", "acme", "review-bot", "acme-team",
		nil, false, "user", []any{},
		viewerID, agentTime, agentTime, nil, nil,
		versionID,
		"1.0.0", "reviews code", "You review code.", "claude-sonnet-4-5",
		map[string]any{}, map[string]any{}, []any{}, []any{"kiro"},
		[]any{}, []any{}, nil,
		"approved", nil,
		"1.0.0",
		"r@x.com", "rawx18",
		true,
	}
	for key, v := range overrides {
		for i, name := range detailCols {
			if name == key {
				row[i] = v
			}
		}
	}
	return row
}

var linkCols = []string{
	"component_type", "component_id", "component_name",
	"resolved_version", "order_index", "config_override",
}

var refCols = []string{"id", "name", "namespace", "slug", "status"}

func TestShowByUUIDRendersDetail(t *testing.T) {
	mcpID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{cols: linkCols, rows: [][]any{
			{"mcp", mcpID, "github-mcp", "1.2.0", int64(0), nil},
		}}},
		{match: "l.name, l.namespace, l.slug, v.status", rows: &fakeRows{cols: refCols, rows: [][]any{
			{mcpID, "github-mcp", "acme", "github-mcp", "approved"},
		}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID, "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d["qualified_name"] != "acme/review-bot" || d["visibility"] != "project" {
		t.Errorf("identity: %v %v", d["qualified_name"], d["visibility"])
	}
	if d["user_permission"] != "owner" || d["latest_version"] != "1.0.0" {
		t.Errorf("viewer fields: %v %v", d["user_permission"], d["latest_version"])
	}
	mcpLinks := d["mcp_links"].([]any)
	if len(mcpLinks) != 1 || mcpLinks[0].(map[string]any)["mcp_name"] != "github-mcp" {
		t.Errorf("mcp_links: %v", mcpLinks)
	}
	compLinks := d["component_links"].([]any)
	if len(compLinks) != 1 {
		t.Fatalf("component_links: %v", compLinks)
	}
	link := compLinks[0].(map[string]any)
	if link["qualified_name"] != "acme/github-mcp" || link["status"] != "approved" {
		t.Errorf("component link: %v", link)
	}
}

func TestShowUnknownAgentIs404(t *testing.T) {
	rec := serveAgents(t, &fakeDB{}, http.MethodGet,
		"/api/v1/agents/11111111-1111-1111-1111-111111111111", "user", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Agent not found") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestShowInvisibleRowIs404(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"row_visible": false, "is_private": true, "created_by": outsiderID}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID, "user", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("private agent leaked: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestShowUnapprovedHiddenFromOutsiders(t *testing.T) {
	pending := detailRow(map[string]any{"status": "pending", "created_by": outsiderID})
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{pending}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID, "user", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("outsider saw unapproved agent: status = %d", rec.Code)
	}

	// Reviewers pass the unapproved gate.
	db = &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{pending}}},
	}}
	rec = serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID, "reviewer", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("reviewer blocked: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestShowUnapprovedVisibleToCreator(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"status": "pending"}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID, "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("creator blocked from own pending agent: status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &d)
	if d["status"] != "pending" || d["user_permission"] != "owner" {
		t.Errorf("detail: %v %v", d["status"], d["user_permission"])
	}
}

func TestShowBareNameAmbiguityIs409(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.slug = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(nil),
			detailRow(map[string]any{"slug": "review-bot-2", "namespace": "beta"}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/reviewbot", "user", "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	if !strings.Contains(out, "is ambiguous") || !strings.Contains(out, "acme/review-bot") ||
		!strings.Contains(out, "beta/review-bot-2") {
		t.Errorf("ambiguity detail: %s", out)
	}
}

func TestShowRejectsEncodedSlash(t *testing.T) {
	db := &fakeDB{}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/acme%2Freview-bot", "user", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestLoadResolvesNamespaceSlug(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.namespace = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	s := &Store{DB: db}
	viewer := &registry.Viewer{ID: uuid.MustParse(viewerID), Role: "user"}
	row, err := s.Load(context.Background(), "acme/review-bot", viewer, false)
	if err != nil || row == nil {
		t.Fatalf("Load = %v, %v", row, err)
	}
	if rowStr(row, "slug", "") != "review-bot" {
		t.Errorf("row: %v", row)
	}
	found := false
	for _, sql := range db.log {
		if strings.Contains(sql, "a.namespace = $") && strings.Contains(sql, "a.slug = $") {
			found = true
			if !strings.Contains(sql, "v.status = 'approved'") {
				t.Errorf("canonical lookup missing the approved gate: %s", sql)
			}
		}
	}
	if !found {
		t.Errorf("no namespace/slug query issued: %v", db.log)
	}
}

func TestLoadResolvesUniqueIDPrefix(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id::text LIKE", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	s := &Store{DB: db}
	viewer := &registry.Viewer{ID: uuid.MustParse(viewerID), Role: "user"}
	row, err := s.Load(context.Background(), "11111111", viewer, false)
	if err != nil || row == nil {
		t.Fatalf("Load = %v, %v", row, err)
	}
	if rowStr(row, "id", "") != agentID {
		t.Errorf("row: %v", row)
	}
}

func TestLoadWithIncludeDeletedDropsFilter(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"deleted_at": agentTime}),
		}}},
	}}
	s := &Store{DB: db}
	viewer := &registry.Viewer{ID: uuid.MustParse(viewerID), Role: "user"}
	row, err := s.LoadWith(context.Background(), agentID, viewer,
		LoadOpts{AllStatuses: true, IncludeDeleted: true})
	if err != nil || row == nil {
		t.Fatalf("LoadWith = %v, %v", row, err)
	}
	for _, sql := range db.log {
		if strings.Contains(sql, "a.id = $") && strings.Contains(sql, "deleted_at IS NULL") {
			t.Errorf("IncludeDeleted kept the deletion filter: %s", sql)
		}
	}
}

func TestNamespaceSlugParts(t *testing.T) {
	cases := []struct {
		in       string
		ns, slug string
		ok       bool
	}{
		{"acme/review-bot", "acme", "review-bot", true},
		{" ACME/Review-Bot ", "acme", "review-bot", true},
		{"no-slash", "", "", false},
		{"a/b/c", "", "", false},
		{"-bad/slug", "", "", false},
		{"acme/", "", "", false},
		{"a..b/slug", "", "", false},
	}
	for _, tc := range cases {
		ns, slug, ok := namespaceSlugParts(tc.in)
		if ns != tc.ns || slug != tc.slug || ok != tc.ok {
			t.Errorf("namespaceSlugParts(%q) = (%q, %q, %v), want (%q, %q, %v)",
				tc.in, ns, slug, ok, tc.ns, tc.slug, tc.ok)
		}
	}
}
