// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/registry"
)

// ── validateComponentsApproved ───────────────────────────────────────────────

func TestValidateComponentsApprovedAllClean(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM mcp_listings", rows: &fakeRows{cols: []string{"id", "name", "status"},
			rows: [][]any{{"aaaaaaaa-1111", "github-mcp", "approved"}}}},
	}}
	s := &Store{DB: db}
	viewer := &registry.Viewer{ID: uuid.MustParse(viewerID), Role: "user"}
	errs, err := s.validateComponentsApproved(context.Background(),
		[]versionComponentRef{{ComponentType: "mcp", ComponentID: "aaaaaaaa-1111"}}, viewer, "")
	if err != nil {
		t.Fatalf("validateComponentsApproved: %v", err)
	}
	if len(errs) != 0 {
		t.Errorf("approved component flagged: %v", errs)
	}
}

func TestValidateComponentsApprovedReportsEachFailure(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM skill_listings", rows: &fakeRows{cols: []string{"id", "name", "status"},
			rows: [][]any{{"bbbbbbbb-2222", "review-skill", "pending"}}}},
		// mcp query returns nothing, so the referenced listing is "not found".
		{match: "FROM mcp_listings", rows: &fakeRows{cols: []string{"id", "name", "status"}, rows: [][]any{}}},
	}}
	s := &Store{DB: db}
	viewer := &registry.Viewer{ID: uuid.MustParse(viewerID), Role: "user"}
	refs := []versionComponentRef{
		{ComponentType: "gadget", ComponentID: "gggg"},
		{ComponentType: "mcp", ComponentID: "aaaaaaaa-9999"},
		{ComponentType: "skill", ComponentID: "bbbbbbbb-2222"},
	}
	errs, err := s.validateComponentsApproved(context.Background(), refs, viewer, "proj-1")
	if err != nil {
		t.Fatalf("validateComponentsApproved: %v", err)
	}
	if len(errs) != 3 {
		t.Fatalf("errors: %v", errs)
	}
	joined := ""
	for _, e := range errs {
		joined += e.Reason + "\n"
	}
	for _, want := range []string{
		"Unknown component type: gadget",
		"mcp listing aaaaaaaa-9999 not found",
		"'review-skill' is not approved (status: pending)",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing reason %q in:\n%s", want, joined)
		}
	}
}

// ── RestoreVersion ───────────────────────────────────────────────────────────

func restoreSourceCols() []string {
	return []string{
		"id", "version", "description", "prompt", "model_name",
		"model_config_json", "models_by_harness", "external_mcps", "supported_harnesses",
		"status", "success_criteria",
	}
}

func restoreSourceRow(status string) []any {
	return []any{
		versionID, "1.0.0", "reviews code", "You review code.", "claude-sonnet-4-5",
		map[string]any{}, map[string]any{}, []any{}, []any{"kiro"},
		status, map[string]any{},
	}
}

func TestRestoreVersionUnknownVersionIs404(t *testing.T) {
	s := &Store{DB: &fakeDB{}}
	agentRow := map[string]any{"id": agentID, "name": "bot", "slug": "bot"}
	viewer := &registry.Viewer{ID: uuid.MustParse(viewerID), Role: "user"}
	_, err := s.RestoreVersion(context.Background(), agentRow, viewer, "9.9.9", nil)
	var inst *errInstall
	if !errors.As(err, &inst) || inst.status != 404 {
		t.Fatalf("missing source version must be 404: %v", err)
	}
}

func TestRestoreVersionUnapprovedSourceIs422(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM agent_versions WHERE agent_id = $1 AND version = $2",
			rows: &fakeRows{cols: restoreSourceCols(), rows: [][]any{restoreSourceRow("pending")}}},
	}}
	s := &Store{DB: db}
	agentRow := map[string]any{"id": agentID, "name": "bot", "slug": "bot"}
	viewer := &registry.Viewer{ID: uuid.MustParse(viewerID), Role: "user"}
	_, err := s.RestoreVersion(context.Background(), agentRow, viewer, "1.0.0", nil)
	var inst *errInstall
	if !errors.As(err, &inst) || inst.status != 422 {
		t.Fatalf("unapproved source must be 422: %v", err)
	}
	if !strings.Contains(inst.detail, "Only approved versions can be restored") {
		t.Errorf("detail: %s", inst.detail)
	}
}

func TestRestoreVersionApprovedSourceReachesReleasePath(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM agent_versions WHERE agent_id = $1 AND version = $2",
			rows: &fakeRows{cols: restoreSourceCols(), rows: [][]any{restoreSourceRow("approved")}}},
		{match: "SELECT version FROM agent_versions WHERE agent_id = $1",
			rows: &fakeRows{cols: []string{"version"}, rows: [][]any{{"1.0.0"}, {"1.1.0"}}}},
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{cols: linkCols, rows: [][]any{}}},
	}}
	s := &Store{DB: db}
	agentRow := map[string]any{"id": agentID, "name": "bot", "slug": "bot", "is_private": false}
	viewer := &registry.Viewer{ID: uuid.MustParse(viewerID), Role: "user"}
	reason := "rollback"
	_, err := s.RestoreVersion(context.Background(), agentRow, viewer, "1.0.0", &reason)
	// The derived release enters CreateVersion, whose transaction cannot begin
	// on the fake, so a non-errInstall error surfaces from that stage.
	if err == nil {
		t.Fatal("expected the release stage to fail on the fake transaction")
	}
	var inst *errInstall
	if errors.As(err, &inst) {
		t.Fatalf("restore stopped early with a mapped error: %v", err)
	}
	scanned := false
	for _, sql := range db.log {
		if strings.Contains(sql, "SELECT version FROM agent_versions WHERE agent_id = $1") {
			scanned = true
		}
	}
	if !scanned {
		t.Errorf("version scan for next-patch not issued: %v", db.log)
	}
}

// ── reviewerRecipients (rich tx) ─────────────────────────────────────────────

func TestReviewerRecipientsPublicWithProjectDedupes(t *testing.T) {
	a := uuid.New()
	b := uuid.New()
	c := uuid.New()
	rdb := &richDB{stubs: []richStub{
		{match: "role IN ('reviewer', 'operator')", rows: &richRows{
			cols: []string{"id"}, rows: [][]any{{a}, {b}}}},
		{match: "FROM project_memberships", rows: &richRows{
			cols: []string{"user_id"}, rows: [][]any{{b}, {c}}}},
	}}
	tx := &richTx{db: rdb}
	agentRow := map[string]any{
		"is_private": false, "project_id": "44444444-4444-4444-4444-444444444444",
	}
	got, err := reviewerRecipients(context.Background(), tx, agentRow)
	if err != nil {
		t.Fatalf("reviewerRecipients: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected three deduped recipients, got %v", got)
	}
	seen := map[uuid.UUID]int{}
	for _, id := range got {
		seen[id]++
	}
	if seen[b] != 1 {
		t.Errorf("overlapping reviewer not deduped: %v", got)
	}
}

func TestReviewerRecipientsPrivateNoProjectUsesOperators(t *testing.T) {
	op := uuid.New()
	rdb := &richDB{stubs: []richStub{
		{match: "WHERE role = 'operator'", rows: &richRows{cols: []string{"id"}, rows: [][]any{{op}}}},
	}}
	tx := &richTx{db: rdb}
	got, err := reviewerRecipients(context.Background(), tx, map[string]any{"is_private": true})
	if err != nil {
		t.Fatalf("reviewerRecipients: %v", err)
	}
	if len(got) != 1 || got[0] != op {
		t.Errorf("private-no-project recipients: %v", got)
	}
}

// ── mcpListingsByID (rich tx) ────────────────────────────────────────────────

func TestMcpListingsByIDEmptyShortCircuits(t *testing.T) {
	rdb := &richDB{}
	tx := &richTx{db: rdb}
	got, err := mcpListingsByID(context.Background(), tx, nil)
	if err != nil || len(got) != 0 {
		t.Fatalf("empty ids: %v, %v", got, err)
	}
	if len(rdb.log) != 0 {
		t.Errorf("empty ids must not query: %v", rdb.log)
	}
}

func TestMcpListingsByIDMapsRows(t *testing.T) {
	rdb := &richDB{stubs: []richStub{
		{match: "FROM mcp_listings", rows: &richRows{
			cols: []string{"id", "name", "slug"}, rows: [][]any{{"aaaaaaaa-1111", "github-mcp", "github-mcp"}}}},
	}}
	tx := &richTx{db: rdb}
	got, err := mcpListingsByID(context.Background(), tx, []string{"aaaaaaaa-1111"})
	if err != nil {
		t.Fatalf("mcpListingsByID: %v", err)
	}
	listing, ok := got["aaaaaaaa-1111"]
	if !ok {
		t.Fatalf("listing not keyed by id: %v", got)
	}
	if listing["name"] != "github-mcp" {
		t.Errorf("listing payload: %v", listing)
	}
}

// ── reviewVersion / restoreVersion handlers (branches not covered elsewhere) ─

func TestReviewVersionTxFailureMapsTo500(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(nil)}}
	rec := serveAgents(t, db, http.MethodPost,
		"/api/v1/agents/"+agentID+"/versions/1.0.0/review", "reviewer", `{"action": "approve"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRestoreVersionHandlerUnknownVersionIs404(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(nil)}}
	rec := serveAgents(t, db, http.MethodPost,
		"/api/v1/agents/"+agentID+"/versions/9.9.9/restore", "user", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Version not found") {
		t.Errorf("body: %s", rec.Body.String())
	}
}
