// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// draftRowStub returns an "a.id = $" detail stub with the given overrides.
func draftRowStub(over map[string]any) stub {
	return stub{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(over)}}}
}

func draftRowStubRich(over map[string]any) richStub {
	return richStub{match: "a.id = $", rows: &richRows{cols: detailCols, rows: [][]any{detailRow(over)}}}
}

// ── update (PUT /agents/{id}) ────────────────────────────────────────────────

func TestUpdateRequiresCredentials(t *testing.T) {
	rec := serveAgentsAnon(t, &fakeDB{}, http.MethodPut, "/api/v1/agents/"+agentID+"/draft")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestUpdateUnknownAgentIs404(t *testing.T) {
	rec := serveAgents(t, &fakeDB{}, http.MethodPut, "/api/v1/agents/"+agentID, "user", "{}")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateRejectsMalformedBody(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(nil)}}
	rec := serveAgents(t, db, http.MethodPut, "/api/v1/agents/"+agentID, "user", "{broken")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Invalid request body") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestUpdateForbiddenForNonOwner(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(map[string]any{"created_by": outsiderID})}}
	rec := serveAgents(t, db, http.MethodPut, "/api/v1/agents/"+agentID, "user", "{}")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Not the agent owner") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestUpdateRejectsVisibilityChange(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(nil)}}
	rec := serveAgents(t, db, http.MethodPut, "/api/v1/agents/"+agentID, "user", `{"visibility": "project"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Visibility cannot be changed here") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestUpdateSuccessCriteriaWithoutVersionIs400(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(map[string]any{"latest_version_id": nil})}}
	rec := serveAgents(t, db, http.MethodPut, "/api/v1/agents/"+agentID, "user", `{"success_criteria": {}}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Agent has no version to update") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestUpdateRejectsBadExternalCommand(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(nil)}}
	rec := serveAgents(t, db, http.MethodPut, "/api/v1/agents/"+agentID, "user",
		`{"external_mcps": [{"name": "x", "command": "curl", "args": ["http://x"]}]}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Invalid MCP command") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestUpdateOwnerFieldSucceeds(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(nil)}}
	rec := serveAgents(t, db, http.MethodPut, "/api/v1/agents/"+agentID, "user", `{"owner": "new-owner"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if countLog(db.log, "UPDATE agents SET") == 0 {
		t.Errorf("agent fields not written: %v", db.log)
	}
}

// ── updateDraft (PUT /agents/{id}/draft) ─────────────────────────────────────

func TestUpdateDraftRejectsNonDraftStatus(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(map[string]any{"status": "approved"})}}
	rec := serveAgents(t, db, http.MethodPut, "/api/v1/agents/"+agentID+"/draft", "user", "{}")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Only draft, rejected, or pending") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestUpdateDraftWithoutVersionIs400(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(map[string]any{"status": "draft", "latest_version_id": nil})}}
	rec := serveAgents(t, db, http.MethodPut, "/api/v1/agents/"+agentID+"/draft", "user", "{}")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Agent has no version to update") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestUpdateDraftRejectsMcpServerIDs(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(map[string]any{"status": "draft"})}}
	rec := serveAgents(t, db, http.MethodPut, "/api/v1/agents/"+agentID+"/draft", "user",
		`{"mcp_server_ids": ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "mcp_server_ids is not accepted here") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestUpdateDraftProjectVisibilityNeedsProject(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(map[string]any{"status": "draft"})}}
	rec := serveAgents(t, db, http.MethodPut, "/api/v1/agents/"+agentID+"/draft", "user",
		`{"visibility": "project"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Project visibility requires a project context") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestUpdateDraftDescriptionSucceeds(t *testing.T) {
	snapCols := []string{
		"version", "description", "prompt", "model_name", "models_by_harness",
		"external_mcps", "supported_harnesses", "model_config_json", "success_criteria",
	}
	db := &richDB{stubs: []richStub{
		draftRowStubRich(map[string]any{"status": "draft"}),
		{match: "SELECT is_editing", rows: &richRows{
			cols: []string{"is_editing", "editing_by", "editing_since"},
			rows: [][]any{{false, nil, nil}}}},
		{match: "FROM agent_versions v WHERE v.id", rows: &richRows{cols: snapCols, rows: [][]any{{
			"1.0.0", "reviews code", "You review code.", "claude-sonnet-4-5",
			map[string]any{}, []any{}, []any{"kiro"}, map[string]any{}, nil,
		}}}},
	}}
	rec := serveAgentsDB(t, db, http.MethodPut, "/api/v1/agents/"+agentID+"/draft", "user",
		`{"description": "updated description"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if countLog(db.log, "is_editing = false") == 0 {
		t.Errorf("edit lock not released on save: %v", db.log)
	}
	if countLog(db.log, "SET yaml_snapshot") == 0 {
		t.Errorf("snapshot not refreshed: %v", db.log)
	}
}

// ── createDraft (POST /agents/draft) ─────────────────────────────────────────

func TestCreateDraftRequiresCredentials(t *testing.T) {
	rec := serveAgentsAnon(t, &fakeDB{}, http.MethodPost, "/api/v1/agents/draft")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestCreateDraftReportsMissingFields(t *testing.T) {
	rec := serveAgentsDB(t, &richDB{}, http.MethodPost, "/api/v1/agents/draft", "user", "{}")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	for _, field := range []string{"name", "version", "owner", "model_name"} {
		if !strings.Contains(out, `"`+field+`"`) {
			t.Errorf("missing-field report lacks %q: %s", field, out)
		}
	}
}

func TestCreateDraftTxFailureMapsTo500(t *testing.T) {
	rec := serveAgentsDB(t, &richDB{}, http.MethodPost, "/api/v1/agents/draft", "user",
		`{"name": "bot", "version": "1.0.0", "owner": "me", "model_name": "m"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

// ── startEdit / cancelEdit ───────────────────────────────────────────────────

func TestStartEditForbiddenForNonOwner(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(map[string]any{"created_by": outsiderID})}}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/start-edit", "user", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestStartEditRejectsApprovedStatus(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(map[string]any{"status": "approved"})}}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/start-edit", "user", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Cannot edit: agent version is 'approved'") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestStartEditLocksDraft(t *testing.T) {
	db := &richDB{stubs: []richStub{
		draftRowStubRich(map[string]any{"status": "draft"}),
		{match: "SELECT is_editing", rows: &richRows{
			cols: []string{"is_editing", "editing_by", "editing_since"},
			rows: [][]any{{false, nil, nil}}}},
	}}
	rec := serveAgentsDB(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/start-edit", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &d)
	if d["status"] != "locked" {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestCancelEditReleasesLock(t *testing.T) {
	db := &richDB{stubs: []richStub{
		draftRowStubRich(map[string]any{"status": "draft"}),
		{match: "SELECT is_editing", rows: &richRows{
			cols: []string{"is_editing", "editing_by", "editing_since"},
			rows: [][]any{{false, nil, nil}}}},
	}}
	rec := serveAgentsDB(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/cancel-edit", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &d)
	if d["status"] != "unlocked" {
		t.Errorf("body: %s", rec.Body.String())
	}
	if countLog(db.log, "is_editing = false") == 0 {
		t.Errorf("lock not released: %v", db.log)
	}
}

// ── submitDraft ──────────────────────────────────────────────────────────────

func TestSubmitDraftRejectsNonDraft(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(map[string]any{"status": "approved"})}}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/submit", "user", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Agent is not a draft") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestSubmitDraftRequiresDescription(t *testing.T) {
	db := &fakeDB{stubs: []stub{draftRowStub(map[string]any{"status": "draft", "description": ""})}}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/submit", "user", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Description is required before submitting") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestSubmitDraftQueuesForReview(t *testing.T) {
	snapCols := []string{
		"version", "description", "prompt", "model_name", "models_by_harness",
		"external_mcps", "supported_harnesses", "model_config_json", "success_criteria",
	}
	db := &fakeDB{stubs: []stub{
		draftRowStub(map[string]any{"status": "draft"}),
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{cols: linkCols, rows: [][]any{}}},
		{match: "FROM agent_versions v WHERE v.id", rows: &fakeRows{cols: snapCols, rows: [][]any{{
			"1.0.0", "reviews code", "You review code.", "claude-sonnet-4-5",
			map[string]any{}, []any{}, []any{"kiro"}, map[string]any{}, nil,
		}}}},
	}}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/submit", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if countLog(db.log, "SET status = 'pending'") == 0 {
		t.Errorf("submission did not queue the version: %v", db.log)
	}
	if countLog(db.log, "gaming_flags") == 0 {
		t.Errorf("gaming scan not recorded: %v", db.log)
	}
}
