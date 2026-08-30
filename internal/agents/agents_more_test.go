// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestMineListsCallerAgents(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.deleted_at IS NULL", rows: &fakeRows{cols: agentCols, rows: [][]any{
			agentRow("11111111-1111-1111-1111-111111111111", "Review Bot", "review-bot"),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/my", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var items []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil || len(items) != 1 {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if items[0]["qualified_name"] != "acme/review-bot" {
		t.Errorf("summary: %v", items[0])
	}
	scoped := false
	for _, sql := range db.log {
		if strings.Contains(sql, "WHERE a.created_by = $") && strings.Contains(sql, "a.deleted_at IS NULL") {
			scoped = true
		}
	}
	if !scoped {
		t.Errorf("mine view not creator-scoped: %v", db.log)
	}
}

func TestValidateReportsVisibleAndMissingComponents(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT l.id::text FROM mcp_listings", rows: &fakeRows{
			cols: []string{"id"}, rows: [][]any{{mcpListingID}}}},
	}}
	body := `{"components": [
		{"component_type": "mcp", "component_id": "` + mcpListingID + `"},
		{"component_type": "skill", "component_id": "` + skillListingID + `"}
	]}`
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/validate", "user", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d["valid"] != false {
		t.Errorf("valid flag: %v", d)
	}
	issues := d["issues"].([]any)
	if len(issues) != 1 {
		t.Fatalf("issues: %v", issues)
	}
	issue := issues[0].(map[string]any)
	if issue["component_type"] != "skill" || !strings.Contains(issue["message"].(string), "not found") {
		t.Errorf("issue: %v", issue)
	}
}

func TestValidateEmptyComponentsIsValid(t *testing.T) {
	db := &fakeDB{}
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/validate", "user", `{"name": "bot"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &d)
	if d["valid"] != true || len(d["issues"].([]any)) != 0 {
		t.Errorf("empty composition: %v", d)
	}
	if len(db.log) != 0 {
		t.Errorf("empty composition reached the database: %v", db.log)
	}
}

func TestCreateVersionValidatesBody(t *testing.T) {
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents/"+agentID+"/versions", "user", "{}")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty body: status = %d: %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	if !strings.Contains(out, `"version"`) || !strings.Contains(out, `"model_name"`) {
		t.Errorf("missing-field report: %s", out)
	}

	body := `{"version": "not-semver", "model_name": "m",
		"components": [{"component_type": "gadget", "component_id": "x"}]}`
	rec = serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents/"+agentID+"/versions", "user", body)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad semver: status = %d", rec.Code)
	}
	out = rec.Body.String()
	if !strings.Contains(out, "Must be semver format") || !strings.Contains(out, "literal_error") {
		t.Errorf("detail: %s", out)
	}
}

func TestCreateVersionForbiddenForNonOwner(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"created_by": outsiderID}),
		}}},
	}}
	body := `{"version": "1.1.0", "model_name": "m"}`
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/versions", "user", body)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Not authorized to release versions") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestCreateVersionTxFailureMapsTo500(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	body := `{"version": "1.1.0", "model_name": "m"}`
	rec := serveAgents(t, db, http.MethodPost, "/api/v1/agents/"+agentID+"/versions", "user", body)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestReviewVersionRequiresReviewerRole(t *testing.T) {
	rec := serveAgents(t, &fakeDB{}, http.MethodPost,
		"/api/v1/agents/"+agentID+"/versions/1.0.0/review", "user", `{"action": "approve"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("plain user: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestReviewVersionValidatesAction(t *testing.T) {
	rec := serveAgents(t, &fakeDB{}, http.MethodPost,
		"/api/v1/agents/"+agentID+"/versions/1.0.0/review", "reviewer", "{}")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing action: status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Field required") {
		t.Errorf("detail: %s", rec.Body.String())
	}

	rec = serveAgents(t, &fakeDB{}, http.MethodPost,
		"/api/v1/agents/"+agentID+"/versions/1.0.0/review", "reviewer", `{"action": "defer"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad action: status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "'approve' or 'reject'") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestRestoreVersionForbiddenForNonOwner(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"created_by": outsiderID}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodPost,
		"/api/v1/agents/"+agentID+"/versions/1.0.0/restore", "user", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Not authorized to restore versions") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestStoreErrorTypes(t *testing.T) {
	if got := (&errNotFound{detail: "gone"}).Error(); got != "gone" {
		t.Errorf("errNotFound: %q", got)
	}
	if got := (&errInstall{status: 409, detail: "taken"}).Error(); got != "taken" {
		t.Errorf("errInstall: %q", got)
	}
	e := &ErrAmbiguous{Label: "bot", Choices: []string{"a/bot", "b/bot"}}
	if got := e.Error(); got != "'bot' is ambiguous; use one of: a/bot, b/bot" {
		t.Errorf("ErrAmbiguous: %q", got)
	}
}
