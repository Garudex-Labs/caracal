// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
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
