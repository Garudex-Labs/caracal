// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	testViewerID = "22222222-2222-2222-2222-222222222222"
	otherUserID  = "33333333-3333-3333-3333-333333333333"
	listingUUID  = "11111111-1111-1111-1111-111111111111"
	versionUUID  = "aaaa1111-1111-1111-1111-111111111111"
)

// mcpShowCols matches detailColumns for mcps.
var mcpShowCols = []string{
	"id", "name", "namespace", "slug", "owner",
	"is_private", "ownership_scope", "submitted_by", "co_authors",
	"created_at", "updated_at", "latest_version_id", "project_id", "bundle_id",
	"version", "description", "status", "rejection_reason", "supported_harnesses",
	"download_count", "is_editing", "editing_by", "editing_since",
	"category", "source_url", "environment_variables", "setup_instructions",
	"changelog", "framework", "docker_image", "command", "args", "url",
	"headers", "auto_approve", "mcp_validated",
}

// mcpShowRow renders one mcp detail row with per-column overrides.
func mcpShowRow(over map[string]any) []any {
	base := map[string]any{
		"id": listingUUID, "name": "Weather", "namespace": "acme", "slug": "weather",
		"owner": "acme-team", "is_private": false, "ownership_scope": "user",
		"submitted_by": testViewerID, "co_authors": []any{},
		"created_at": testNow, "updated_at": testNow,
		"latest_version_id": versionUUID, "project_id": nil, "bundle_id": nil,
		"version": "1.2.0", "description": "a component", "status": "approved",
		"rejection_reason": nil, "supported_harnesses": []any{"kiro"},
		"download_count": int64(3), "is_editing": false, "editing_by": nil, "editing_since": nil,
		"category": "general", "source_url": nil, "environment_variables": []any{},
		"setup_instructions": nil, "changelog": nil, "framework": nil, "docker_image": nil,
		"command": nil, "args": []any{}, "url": nil,
		"headers": nil, "auto_approve": []any{}, "mcp_validated": false,
	}
	for k, v := range over {
		base[k] = v
	}
	out := make([]any, len(mcpShowCols))
	for i, c := range mcpShowCols {
		out[i] = base[c]
	}
	return out
}

// mcpShowStub answers the mcp detail resolve with one row.
func mcpShowStub(over map[string]any) stub {
	return stub{match: "FROM mcp_listings", rows: &fakeRows{cols: mcpShowCols, rows: [][]any{mcpShowRow(over)}}}
}

// execCapableDB is a fakeDB whose Exec answers come from a hook, letting
// tests shape command tags and errors per statement.
type execCapableDB struct {
	*fakeDB
	exec func(sql string) (pgconn.CommandTag, error)
}

func (d *execCapableDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	d.log = append(d.log, sql)
	if d.exec != nil {
		return d.exec(sql)
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func testViewer(role string) *Viewer {
	return &Viewer{ID: uuid.MustParse(testViewerID), Role: role}
}

func asAPIError(t *testing.T, err error) *apiError {
	t.Helper()
	var api *apiError
	if !errors.As(err, &api) {
		t.Fatalf("expected *apiError, got %T: %v", err, err)
	}
	return api
}

func TestArchiveOwnerMovesApprovedListing(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(nil)}}
	rec := serveRegistry(t, db, http.MethodPatch, "/api/v1/mcps/"+listingUUID+"/archive", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"status":"archived"`) || !strings.Contains(body, `"Weather"`) {
		t.Errorf("archive body: %s", body)
	}
	found := false
	for _, sql := range db.log {
		if strings.Contains(sql, "UPDATE mcp_versions SET status") {
			found = true
		}
	}
	if !found {
		t.Errorf("no status update issued:\n%v", db.log)
	}
}

func TestArchiveRejectsNonOwner(t *testing.T) {
	cases := map[string]map[string]any{
		"private scope stays creator-only": {"submitted_by": otherUserID, "ownership_scope": "private"},
		"no project means no authority":    {"submitted_by": otherUserID, "ownership_scope": "team", "project_id": nil},
	}
	for name, over := range cases {
		db := &fakeDB{stubs: []stub{mcpShowStub(over)}}
		rec := serveRegistry(t, db, http.MethodPatch, "/api/v1/mcps/"+listingUUID+"/archive", "user")
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s: status = %d: %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestArchiveUnknownListing404(t *testing.T) {
	rec := serveRegistry(t, &fakeDB{}, http.MethodPatch, "/api/v1/mcps/"+listingUUID+"/archive", "user")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Listing not found") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestArchiveRequiresApprovedStatus(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"status": "pending"})}}
	rec := serveRegistry(t, db, http.MethodPatch, "/api/v1/mcps/"+listingUUID+"/archive", "user")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	// mcp predates the naming scheme and reads as "listing".
	if !strings.Contains(rec.Body.String(), "Only approved listings can be archived") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestArchiveErrorNamesTheFamily(t *testing.T) {
	// Minimal skill fixture: only the columns the archive path reads.
	cols := []string{"id", "name", "submitted_by", "co_authors", "latest_version_id", "status", "ownership_scope"}
	db := &fakeDB{stubs: []stub{
		{match: "FROM skill_listings", rows: &fakeRows{cols: cols, rows: [][]any{
			{listingUUID, "Sifter", testViewerID, []any{}, versionUUID, "pending", "user"},
		}}},
	}}
	rec := serveRegistry(t, db, http.MethodPatch, "/api/v1/skills/"+listingUUID+"/archive", "user")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Only approved skills can be archived") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestUnarchiveTransitions(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"status": "archived"})}}
	rec := serveRegistry(t, db, http.MethodPatch, "/api/v1/mcps/"+listingUUID+"/unarchive", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"status":"approved"`) {
		t.Errorf("unarchive body: %s", rec.Body.String())
	}

	notArchived := &fakeDB{stubs: []stub{mcpShowStub(nil)}}
	rec = serveRegistry(t, notArchived, http.MethodPatch, "/api/v1/mcps/"+listingUUID+"/unarchive", "user")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("not archived: status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Listing is not archived") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestStartEditAcquiresLock(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"status": "draft"})}}
	rec := serveRegistry(t, db, http.MethodPost, "/api/v1/mcps/"+listingUUID+"/start-edit", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"status":"locked"`) {
		t.Errorf("body: %s", rec.Body.String())
	}
	found := false
	for _, sql := range db.log {
		if strings.Contains(sql, "SET is_editing = TRUE") {
			found = true
		}
	}
	if !found {
		t.Errorf("no lock acquisition issued:\n%v", db.log)
	}
}

func TestStartEditRefusesReleasedStatus(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(nil)}} // approved
	rec := serveRegistry(t, db, http.MethodPost, "/api/v1/mcps/"+listingUUID+"/start-edit", "user")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Cannot edit: listing is 'approved'") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestStartEditRequiresOwnerAndVersion(t *testing.T) {
	notOwner := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"submitted_by": otherUserID})}}
	rec := serveRegistry(t, notOwner, http.MethodPost, "/api/v1/mcps/"+listingUUID+"/start-edit", "user")
	if rec.Code != http.StatusForbidden {
		t.Errorf("non-owner: status = %d: %s", rec.Code, rec.Body.String())
	}

	noVersion := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"latest_version_id": nil, "status": "draft"})}}
	rec = serveRegistry(t, noVersion, http.MethodPost, "/api/v1/mcps/"+listingUUID+"/start-edit", "user")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("no version: status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Listing has no version") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestStartEditContentionConflicts(t *testing.T) {
	db := &execCapableDB{
		fakeDB: &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"status": "draft"})}},
		exec: func(string) (pgconn.CommandTag, error) {
			return pgconn.NewCommandTag("UPDATE 0"), nil
		},
	}
	s := &Store{DB: db}
	err := s.StartEdit(context.Background(), Families["mcps"], listingUUID, testViewer("user"))
	api := asAPIError(t, err)
	if api.Status != 409 || !strings.Contains(api.Detail, "currently being edited") {
		t.Errorf("contention: %d %q", api.Status, api.Detail)
	}
}

func TestCancelEditPaths(t *testing.T) {
	// Not locked: a no-op success without any UPDATE.
	free := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"status": "draft"})}}
	rec := serveRegistry(t, free, http.MethodPost, "/api/v1/mcps/"+listingUUID+"/cancel-edit", "user")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"unlocked"`) {
		t.Fatalf("free lock: %d %s", rec.Code, rec.Body.String())
	}
	for _, sql := range free.log {
		if strings.Contains(sql, "SET is_editing = FALSE") {
			t.Errorf("unexpected release UPDATE: %s", sql)
		}
	}

	// Held by someone else: refused.
	foreign := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{
		"status": "draft", "is_editing": true, "editing_by": otherUserID,
	})}}
	rec = serveRegistry(t, foreign, http.MethodPost, "/api/v1/mcps/"+listingUUID+"/cancel-edit", "user")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("foreign lock: status = %d: %s", rec.Code, rec.Body.String())
	}

	// Held by the caller: released.
	mine := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{
		"status": "draft", "is_editing": true, "editing_by": testViewerID,
	})}}
	rec = serveRegistry(t, mine, http.MethodPost, "/api/v1/mcps/"+listingUUID+"/cancel-edit", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("own lock: status = %d: %s", rec.Code, rec.Body.String())
	}
	found := false
	for _, sql := range mine.log {
		if strings.Contains(sql, "SET is_editing = FALSE") {
			found = true
		}
	}
	if !found {
		t.Errorf("no release UPDATE issued:\n%v", mine.log)
	}
}
