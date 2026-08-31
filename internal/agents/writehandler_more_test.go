// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/resretention"
)

func TestStoreRestoreRejectsBadRename(t *testing.T) {
	s := &Store{DB: &fakeDB{}}
	row := map[string]any{"id": agentID, "name": "Review Bot", "slug": "review-bot", "namespace": "acme"}
	_, _, err := s.Restore(context.Background(), row, "!!!")
	var inst *errInstall
	if !errors.As(err, &inst) || inst.status != 422 {
		t.Fatalf("invalid rename must be 422: %v", err)
	}
}

func TestStoreRestoreConflictIs409(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT id::text FROM agents", rows: &fakeRows{
			cols: []string{"id"}, rows: [][]any{{"88888888-8888-8888-8888-888888888888"}}}},
	}}
	s := &Store{DB: db}
	row := map[string]any{"id": agentID, "name": "Review Bot", "slug": "review-bot", "namespace": "acme"}
	_, _, err := s.Restore(context.Background(), row, "")
	var inst *errInstall
	if !errors.As(err, &inst) || inst.status != 409 {
		t.Fatalf("namespace clash must be 409: %v", err)
	}
	if !strings.Contains(inst.detail, "already exists") {
		t.Errorf("detail: %s", inst.detail)
	}
}

func TestStoreRestoreSucceeds(t *testing.T) {
	db := &fakeDB{}
	s := &Store{DB: db}
	row := map[string]any{"id": agentID, "name": "Review Bot", "slug": "review-bot", "namespace": "acme"}
	name, slug, err := s.Restore(context.Background(), row, "renamed-bot")
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if name != "renamed-bot" || slug != "renamed-bot" {
		t.Errorf("restore identity: %q / %q", name, slug)
	}
	if countLog(db.log, "UPDATE agents SET name = $1, slug = $2, deleted_at = NULL, scheduled_purge_at = NULL") != 1 {
		t.Errorf("undelete not issued: %v", db.log)
	}
}

func TestStoreSoftDeleteSetsScheduledPurge(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "UPDATE agents", rows: &fakeRows{cols: []string{"name"}, rows: [][]any{
			{"Review Bot"},
		}}},
	}}
	s := &Store{DB: db}
	name, _, scheduled, err := s.SoftDelete(context.Background(), agentID, resretention.ClassProject,
		resretention.Policy{PrivateRetentionDays: 0, ProjectRetentionDays: 7})
	if err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	if name != "Review Bot" || scheduled.Before(time.Now().UTC().AddDate(0, 0, 6)) {
		t.Fatalf("soft delete result = %q %s", name, scheduled)
	}
	if countLog(db.log, "scheduled_purge_at") == 0 || countLog(db.log, "make_interval") == 0 {
		t.Fatalf("scheduled purge not persisted: %v", db.log)
	}
}

func TestDeleteAgentUsesProjectRetentionPolicy(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"project_id": "66666666-6666-6666-6666-666666666666", "ownership_scope": "private", "is_private": true}),
		}}},
		{match: "FROM project_resource_retention_policies", rows: &fakeRows{cols: []string{"private_retention_days", "project_retention_days"}, rows: [][]any{{0, 7}}}},
		{match: "UPDATE agents", rows: &fakeRows{cols: []string{"name"}, rows: [][]any{{"Review Bot"}}}},
	}}
	rec := serveAgents(t, db, http.MethodDelete, "/api/v1/agents/"+agentID, "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if countLog(db.log, "FROM project_resource_retention_policies") != 1 || !strings.Contains(rec.Body.String(), "scheduled_purge_at") {
		t.Fatalf("policy read or response missing: log=%v body=%s", db.log, rec.Body.String())
	}
}

func TestRestoreHandlerForbiddenForNonOwner(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"deleted_at": agentTime, "created_by": outsiderID}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodPatch, "/api/v1/agents/"+agentID+"/restore", "user", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRestoreHandlerAllowsProjectLead(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"deleted_at": agentTime, "created_by": outsiderID, "project_id": "66666666-6666-6666-6666-666666666666", "ownership_scope": "project"}),
		}}},
		{match: "SELECT EXISTS", rows: &fakeRows{cols: []string{"exists"}, rows: [][]any{{true}}}},
	}}
	rec := serveAgents(t, db, http.MethodPatch, "/api/v1/agents/"+agentID+"/restore", "user", "{}")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRestoreHandlerSucceeds(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"deleted_at": agentTime}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodPatch, "/api/v1/agents/"+agentID+"/restore", "user",
		`{"name": "review-bot"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if countLog(db.log, "deleted_at = NULL") == 0 {
		t.Errorf("agent not undeleted: %v", db.log)
	}
}

func TestRestoreHandlerRejectsExpiredRetention(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"deleted_at": agentTime, "scheduled_purge_at": time.Now().UTC().Add(-time.Hour)}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodPatch, "/api/v1/agents/"+agentID+"/restore", "user", "{}")
	if rec.Code != http.StatusGone {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if countLog(db.log, "deleted_at = NULL") != 0 {
		t.Errorf("expired restore mutated row: %v", db.log)
	}
}

func TestPurgeDeletedAgentRequiresConfirmation(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"deleted_at": agentTime}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/purge", "user", `{"confirm":"delete"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if countLog(db.log, "DELETE FROM agents") != 0 {
		t.Errorf("unconfirmed purge deleted row: %v", db.log)
	}
}

func TestPurgeDeletedAgentSucceeds(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"deleted_at": agentTime}),
		}}},
		{match: "DELETE FROM agents", rows: &fakeRows{cols: []string{"name"}, rows: [][]any{{"Review Bot"}}}},
	}}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/purge", "user", `{"confirm":"permanently delete"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if countLog(db.log, "DELETE FROM agents WHERE id = $1 AND deleted_at IS NOT NULL") != 1 {
		t.Errorf("purge not issued: %v", db.log)
	}
}

func TestCreateAgentRejectsEmptyDescription(t *testing.T) {
	body := `{"name": "bot", "version": "1.0.0", "owner": "me", "model_name": "m"}`
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents", "user", body)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Description must not be empty") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestInstallListingsScopesAndMaps(t *testing.T) {
	mcpID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	db := &fakeDB{stubs: []stub{
		{match: "FROM mcp_listings l LEFT JOIN mcp_versions", rows: &fakeRows{
			cols: []string{"id", "name", "slug", "namespace", "status", "description"},
			rows: [][]any{{mcpID, "github-mcp", "github-mcp", "acme", "approved", "gh tools"}}}},
	}}
	s := &Store{DB: db}
	viewer := &registry.Viewer{ID: uuid.MustParse(viewerID), Role: "user"}
	got, err := s.installListings(context.Background(), "mcp", []string{mcpID}, viewer, "proj-1", nil)
	if err != nil {
		t.Fatalf("installListings: %v", err)
	}
	if listing, ok := got[mcpID]; !ok || listing["name"] != "github-mcp" {
		t.Errorf("listing map: %v", got)
	}
	scoped := false
	for _, sql := range db.log {
		if strings.Contains(sql, "l.is_private = TRUE AND l.project_id = $") {
			scoped = true
		}
	}
	if !scoped {
		t.Errorf("project audience scope missing: %v", db.log)
	}

	// An empty id set never touches the database.
	empty := &fakeDB{}
	if got, err := (&Store{DB: empty}).installListings(context.Background(), "mcp", nil, viewer, "", nil); err != nil || len(got) != 0 {
		t.Errorf("empty ids: %v, %v", got, err)
	}
	if len(empty.log) != 0 {
		t.Errorf("empty ids queried the database: %v", empty.log)
	}
}
