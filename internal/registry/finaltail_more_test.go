// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func mustUUID(t *testing.T, raw string) uuid.UUID {
	t.Helper()
	return uuid.MustParse(raw)
}

func TestTriggerSyncRequiresAdmin(t *testing.T) {
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost,
		"/api/v1/component-sources/"+listingUUID+"/sync", "user", strings.NewReader("{}"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Insufficient permissions") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestTriggerSyncUnknownSource404(t *testing.T) {
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost,
		"/api/v1/component-sources/"+listingUUID+"/sync", "operator", strings.NewReader("{}"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Source not found") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestTriggerSyncRecordsFailedRun(t *testing.T) {
	badRepo := filepath.Join(t.TempDir(), "does-not-exist")
	db := &fakeDB{stubs: []stub{
		{match: "FROM component_sources WHERE id", rows: &fakeRows{
			cols: []string{"url", "component_type"},
			rows: [][]any{{badRepo, "mcp"}},
		}},
	}}
	s := &Store{DB: db}
	viewer := testViewer("operator")
	resp, err := s.TriggerSync(context.Background(), viewer, mustUUID(t, listingUUID), testMirror(t))
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if resp.Status != "failed" || resp.Error == nil || resp.ComponentsFound != 0 {
		t.Errorf("response: %+v", resp)
	}
	var sawSyncing, sawResult bool
	for _, sql := range db.log {
		if strings.Contains(sql, "sync_status = 'syncing'") {
			sawSyncing = true
		}
		if strings.Contains(sql, "last_synced_at = now()") {
			sawResult = true
		}
	}
	if !sawSyncing || !sawResult {
		t.Errorf("status transitions missing: syncing=%v result=%v\n%v", sawSyncing, sawResult, db.log)
	}
}

func TestTriggerSyncSucceedsOnRealRepo(t *testing.T) {
	repo := createGitRepo(t, filepath.Join(t.TempDir(), "src"), map[string]string{
		"server.py": fastMCPServer(),
	})
	db := &fakeDB{stubs: []stub{
		{match: "FROM component_sources WHERE id", rows: &fakeRows{
			cols: []string{"url", "component_type"},
			rows: [][]any{{repo, "mcp"}},
		}},
	}}
	s := &Store{DB: db}
	resp, err := s.TriggerSync(context.Background(), testViewer("operator"), mustUUID(t, listingUUID), testMirror(t))
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if resp.Status != "success" || resp.CommitSHA == "" {
		t.Errorf("response: %+v", resp)
	}
	if resp.SourceID != listingUUID {
		t.Errorf("source id: %q", resp.SourceID)
	}
}

func TestSourceSyncerCycleProcessesDueSources(t *testing.T) {
	badRepo := filepath.Join(t.TempDir(), "gone")
	db := &fakeDB{stubs: []stub{
		{match: "auto_sync_interval IS NOT NULL", rows: &fakeRows{
			cols: []string{"id", "url", "component_type"},
			rows: [][]any{{listingUUID, badRepo, "mcp"}},
		}},
	}}
	syncer := &SourceSyncer{DB: db, Mirror: testMirror(t)}
	syncer.Cycle(context.Background())
	var sawResult bool
	for _, sql := range db.log {
		if strings.Contains(sql, "sync_status = $2") {
			sawResult = true
		}
	}
	if !sawResult {
		t.Errorf("cycle recorded nothing:\n%v", db.log)
	}
}

func TestSourceSyncerCycleSurvivesListFailure(t *testing.T) {
	db := &fakeDB{stubs: []stub{{match: "auto_sync_interval", err: errBoom}}}
	syncer := &SourceSyncer{DB: db, Mirror: testMirror(t)}
	syncer.Cycle(context.Background()) // must not panic
	if len(db.log) != 1 {
		t.Errorf("log = %v", db.log)
	}
}

func TestAnalyzeRepoExtractsFastMCPSignature(t *testing.T) {
	repo := createGitRepo(t, filepath.Join(t.TempDir(), "src"), map[string]string{
		"server.py": "import os\n" +
			"from mcp.server.fastmcp import FastMCP\n" +
			"mcp = FastMCP(\"weather-mcp\")\n" +
			"token = os.environ[\"WEATHER_TOKEN\"]\n" +
			"@mcp.tool()\ndef forecast(city):\n    return city\n",
	})
	s := &Store{}
	out := s.AnalyzeRepo(context.Background(), repo, testMirror(t))
	if out["name"] != "weather-mcp" || out["framework"] != "python" || out["command"] != "python" {
		t.Errorf("analysis: %v", out)
	}
	tools, _ := out["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools: %v", tools)
	}
	if tool, _ := tools[0].(map[string]any); tool["name"] != "forecast" {
		t.Errorf("tool: %v", tools[0])
	}
	envs, _ := out["environment_variables"].([]any)
	if len(envs) != 1 {
		t.Fatalf("envs: %v", envs)
	}
	if env, _ := envs[0].(map[string]any); env["name"] != "WEATHER_TOKEN" {
		t.Errorf("env: %v", envs[0])
	}
	args, _ := out["args"].([]any)
	if len(args) != 1 || args[0] != "server.py" {
		t.Errorf("args: %v", args)
	}
}

func TestAnalyzeRepoFallsBackToRepoName(t *testing.T) {
	repo := createGitRepo(t, filepath.Join(t.TempDir(), "plain-scripts"), map[string]string{
		"README.md": "no python here",
	})
	s := &Store{}
	out := s.AnalyzeRepo(context.Background(), repo, testMirror(t))
	if out["name"] != "plain-scripts" || out["command"] != nil || out["framework"] != nil {
		t.Errorf("fallback analysis: %v", out)
	}
}

func TestAnalyzeRepoReportsCloneFailure(t *testing.T) {
	s := &Store{}
	out := s.AnalyzeRepo(context.Background(), filepath.Join(t.TempDir(), "missing"), testMirror(t))
	errMsg, _ := out["error"].(string)
	if errMsg == "" || out["name"] != "" {
		t.Errorf("clone failure analysis: %v", out)
	}
}

func TestAnalyzeMcpEndpointRequiresGitURL(t *testing.T) {
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost, "/api/v1/mcps/analyze", "user",
		strings.NewReader(`{}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing git_url: %d %s", rec.Code, rec.Body.String())
	}
}

func TestEnvList(t *testing.T) {
	out := envList(map[string]bool{"A_TOKEN": true})
	if len(out) != 1 {
		t.Fatalf("envList = %v", out)
	}
	entry, _ := out[0].(map[string]any)
	if entry["name"] != "A_TOKEN" || entry["required"] != true {
		t.Errorf("entry = %v", entry)
	}
	if got := envList(nil); len(got) != 0 {
		t.Errorf("empty = %v", got)
	}
}

func TestUpdateVisibilityValidation(t *testing.T) {
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPatch,
		"/api/v1/registry/widget/"+listingUUID+"/visibility", "user",
		strings.NewReader(`{"visibility":"public"}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad item type: %d %s", rec.Code, rec.Body.String())
	}
	rec = serveRegistryReq(t, &fakeDB{}, http.MethodPatch,
		"/api/v1/registry/mcp/"+listingUUID+"/visibility", "user",
		strings.NewReader(`{"visibility":"secret"}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad visibility: %d %s", rec.Code, rec.Body.String())
	}
	rec = serveRegistryReq(t, &fakeDB{}, http.MethodPatch,
		"/api/v1/registry/mcp/"+listingUUID+"/visibility", "user",
		strings.NewReader(`{"visibility":"public"}`))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Listing not found") {
		t.Errorf("unknown listing: %d %s", rec.Code, rec.Body.String())
	}
}

func TestBulkAgentsBodyValidation(t *testing.T) {
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost, "/api/v1/bulk/agents", "user",
		strings.NewReader(`{"dry_run":true}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), `"agents"`) {
		t.Errorf("missing agents: %d %s", rec.Code, rec.Body.String())
	}
	rec = serveRegistryReq(t, &fakeDB{}, http.MethodPost, "/api/v1/bulk/agents", "user",
		strings.NewReader(`{"agents":[{"description":"unnamed"}]}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), `"name"`) {
		t.Errorf("unnamed agent: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAgentCoAuthorsUnknownAgent404(t *testing.T) {
	rec := serveRegistry(t, &fakeDB{}, http.MethodGet,
		"/api/v1/agents/"+listingUUID+"/co-authors", "user")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Agent not found") {
		t.Errorf("unknown agent: %d %s", rec.Code, rec.Body.String())
	}
}

// agentRowStub answers the agentRow probe with one agent.
func agentRowStub(createdBy string, coAuthors []any) stub {
	return stub{match: "FROM agents WHERE id", rows: &fakeRows{
		cols: []string{"id", "created_by", "project_id", "latest_version_id", "co_authors", "name"},
		rows: [][]any{{listingUUID, createdBy, nil, versionUUID, coAuthors, "Helper"}},
	}}
}

func TestAgentCoAuthorsListAndEditors(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		agentRowStub(otherUserID, []any{testViewerID}),
		{match: "FROM users WHERE id = ANY", rows: &fakeRows{
			cols: []string{"id", "email", "username", "auth_provider"},
			rows: [][]any{{testViewerID, "me@example.com", "me", "password"}},
		}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/agents/"+listingUUID+"/co-authors", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var users []coAuthorUser
	if err := json.Unmarshal(rec.Body.Bytes(), &users); err != nil || len(users) != 1 {
		t.Fatalf("users: %v %s", err, rec.Body.String())
	}
	if users[0].Email != "me@example.com" || !users[0].IsActive {
		t.Errorf("user: %+v", users[0])
	}

	editors := &fakeDB{stubs: []stub{
		agentRowStub(otherUserID, []any{}),
		{match: "DISTINCT released_by", rows: &fakeRows{
			cols: []string{"released_by"},
			rows: [][]any{{otherUserID}},
		}},
		{match: "FROM users WHERE id = ANY", rows: &fakeRows{
			cols: []string{"id", "email", "username", "auth_provider"},
			rows: [][]any{{otherUserID, "them@example.com", "them", "password"}},
		}},
	}}
	rec = serveRegistry(t, editors, http.MethodGet, "/api/v1/agents/"+listingUUID+"/editors", "user")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "them@example.com") {
		t.Errorf("editors: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAddAgentCoAuthorGates(t *testing.T) {
	// Only the creator or an admin manages seats.
	db := &fakeDB{stubs: []stub{agentRowStub(otherUserID, []any{})}}
	rec := serveRegistryReq(t, db, http.MethodPost, "/api/v1/agents/"+listingUUID+"/co-authors",
		"user", strings.NewReader(`{"user_id":"`+otherUserID+`"}`))
	if rec.Code != http.StatusForbidden {
		t.Errorf("non-creator: %d %s", rec.Code, rec.Body.String())
	}

	// The owner is already implicit.
	owner := &fakeDB{stubs: []stub{
		agentRowStub(testViewerID, []any{}),
		usersStub(testViewerID, "me", "me@example.com", "password"),
	}}
	rec = serveRegistryReq(t, owner, http.MethodPost, "/api/v1/agents/"+listingUUID+"/co-authors",
		"user", strings.NewReader(`{"user_id":"`+testViewerID+`"}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "already implicit") {
		t.Errorf("owner implicit: %d %s", rec.Code, rec.Body.String())
	}

	// Duplicates conflict.
	dup := &fakeDB{stubs: []stub{
		agentRowStub(testViewerID, []any{otherUserID}),
		usersStub(otherUserID, "them", "them@example.com", "password"),
	}}
	rec = serveRegistryReq(t, dup, http.MethodPost, "/api/v1/agents/"+listingUUID+"/co-authors",
		"user", strings.NewReader(`{"user_id":"`+otherUserID+`"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "already a co-author") {
		t.Errorf("duplicate: %d %s", rec.Code, rec.Body.String())
	}

	// A fresh collaborator is persisted and echoed.
	fresh := &fakeDB{stubs: []stub{
		agentRowStub(testViewerID, []any{}),
		usersStub(otherUserID, "them", "them@example.com", "password"),
	}}
	rec = serveRegistryReq(t, fresh, http.MethodPost, "/api/v1/agents/"+listingUUID+"/co-authors",
		"user", strings.NewReader(`{"user_id":"`+otherUserID+`"}`))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "them@example.com") {
		t.Fatalf("add: %d %s", rec.Code, rec.Body.String())
	}
	found := false
	for _, sql := range fresh.log {
		if strings.Contains(sql, "UPDATE agents SET co_authors") {
			found = true
		}
	}
	if !found {
		t.Errorf("no co-author update issued:\n%v", fresh.log)
	}
}

func TestRemoveAgentCoAuthor(t *testing.T) {
	db := &fakeDB{stubs: []stub{agentRowStub(testViewerID, []any{otherUserID})}}
	rec := serveRegistryReq(t, db, http.MethodDelete,
		"/api/v1/agents/"+listingUUID+"/co-authors/"+otherUserID, "user", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Co-author removed") {
		t.Fatalf("remove: %d %s", rec.Code, rec.Body.String())
	}

	missing := &fakeDB{stubs: []stub{agentRowStub(testViewerID, []any{})}}
	rec = serveRegistryReq(t, missing, http.MethodDelete,
		"/api/v1/agents/"+listingUUID+"/co-authors/"+otherUserID, "user", nil)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "not a co-author") {
		t.Errorf("missing seat: %d %s", rec.Code, rec.Body.String())
	}
}
