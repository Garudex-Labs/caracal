// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/registry"
)

func contextWithTestClaims(ctx context.Context) context.Context {
	return httpapi.ContextWithClaims(ctx, auth.Claims{
		UserID: uuid.MustParse(viewerID),
		Role:   "user",
	})
}

// serveAgentsAnon serves a request with no claims on the context, so the
// optional-auth routes see an anonymous caller and the strict ones reject.
func serveAgentsAnon(t *testing.T, db *fakeDB, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	h := &Handler{Store: &Store{DB: db}}
	mux := http.NewServeMux()
	identity := func(next http.Handler) http.Handler { return next }
	h.Register(mux, identity, identity)
	req := httptest.NewRequest(method, target, strings.NewReader(""))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

type fakeRegistryStore struct{}

func (fakeRegistryStore) AmbientProjectID(context.Context, *http.Request, *registry.Viewer) (*uuid.UUID, error) {
	return nil, nil
}

func TestDownloadStatsRendersCounts(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "count(DISTINCT user_id)", rows: &fakeRows{
			cols: []string{"count", "count", "count"}, rows: [][]any{{int64(5), int64(3), int64(2)}}}},
		{match: "GROUP BY source", rows: &fakeRows{
			cols: []string{"source", "count"}, rows: [][]any{{"api", int64(4)}, {"cli", int64(1)}}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/downloads", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d["total"] != float64(5) || d["total_downloads"] != float64(5) ||
		d["unique_users"] != float64(3) || d["recent_7d"] != float64(2) {
		t.Errorf("counts: %v", d)
	}
	sources := d["sources"].(map[string]any)
	if sources["api"] != float64(4) || sources["cli"] != float64(1) {
		t.Errorf("sources: %v", sources)
	}
}

func TestDownloadsAllowsAnonymousCallers(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "count(DISTINCT user_id)", rows: &fakeRows{
			cols: []string{"count", "count", "count"}, rows: [][]any{{int64(1), int64(1), int64(0)}}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgentsAnon(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/downloads")
	if rec.Code != http.StatusOK {
		t.Fatalf("anonymous downloads: status = %d: %s", rec.Code, rec.Body.String())
	}
	// The strict routes still demand credentials in the same registration.
	rec = serveAgentsAnon(t, db, http.MethodGet, "/api/v1/agents/"+agentID)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous show: status = %d", rec.Code)
	}
}

func TestTracesRendersEmptyEnvelope(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/traces", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &d)
	if d["agent_id"] != agentID || d["count"] != float64(0) || len(d["traces"].([]any)) != 0 {
		t.Errorf("envelope: %v", d)
	}
}

func TestTracesValidatesParams(t *testing.T) {
	db := &fakeDB{}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/traces?limit=0", "user", "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(db.log) != 0 {
		t.Errorf("invalid params reached the database: %v", db.log)
	}
}

func TestDeletedListingScopesToCreatorForUsers(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.deleted_at IS NOT NULL", rows: &fakeRows{cols: agentCols, rows: [][]any{
			agentRow("11111111-1111-1111-1111-111111111111", "Review Bot", "review-bot"),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/deleted", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	scoped := false
	for _, sql := range db.log {
		if strings.Contains(sql, "a.deleted_at IS NOT NULL") && strings.Contains(sql, "a.created_by = $") &&
			strings.Contains(sql, "a.ownership_scope <> 'private'") {
			scoped = true
		}
	}
	if !scoped {
		t.Errorf("user deleted view not creator-scoped: %v", db.log)
	}

	adminDB := &fakeDB{stubs: []stub{
		{match: "a.deleted_at IS NOT NULL", rows: &fakeRows{cols: agentCols, rows: [][]any{}}},
	}}
	rec = serveAgents(t, adminDB, http.MethodGet, "/api/v1/agents/deleted", "operator", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("operator status = %d", rec.Code)
	}
	for _, sql := range adminDB.log {
		if strings.Contains(sql, "a.deleted_at IS NOT NULL") && strings.Contains(sql, "a.created_by = $") {
			t.Errorf("operator deleted view is creator-scoped: %s", sql)
		}
	}
}

func TestPreviewConfigValidatesComponents(t *testing.T) {
	body := `{"components": [
		{"component_type": "gadget", "component_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
		{"component_type": "mcp", "component_id": "nope"}
	]}`
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents/preview-config", "user", body)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	if !strings.Contains(out, "string_pattern_mismatch") || !strings.Contains(out, "uuid_parsing") {
		t.Errorf("validation detail: %s", out)
	}
}

func TestPreviewConfigRejectsOversizedName(t *testing.T) {
	body := `{"name": "` + strings.Repeat("x", 101) + `"}`
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents/preview-config", "user", body)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "string_too_long") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestPreviewConfigRejectsMalformedJSON(t *testing.T) {
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents/preview-config", "user", "[1, 2]")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "model_attributes_type") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestPreviewConfigUnknownComponentIs404(t *testing.T) {
	body := `{"components": [{"component_type": "mcp", "component_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]}`
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents/preview-config", "user", body)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Component not found: aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestPreviewConfigGeneratesForEmptyComposition(t *testing.T) {
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents/preview-config", "user",
		`{"name": "bot", "prompt": "You review code."}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]map[string]map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	configs, ok := d["configs"]
	if !ok {
		t.Fatalf("configs missing: %s", rec.Body.String())
	}
	if len(configs) == 0 {
		t.Errorf("no harness produced files: %s", rec.Body.String())
	}
}

func TestArchiveFlipsLatestVersionStatus(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodPatch, "/api/v1/agents/"+agentID+"/archive", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &d)
	if d["status"] != "archived" || d["id"] != agentID {
		t.Errorf("archive response: %v", d)
	}
	flipped := false
	for _, sql := range db.log {
		if strings.Contains(sql, "UPDATE agent_versions SET status") {
			flipped = true
		}
	}
	if !flipped {
		t.Errorf("no status update issued: %v", db.log)
	}
}

func TestArchiveForbiddenForNonOwner(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"created_by": outsiderID}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodPatch, "/api/v1/agents/"+agentID+"/archive", "user", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUnarchiveRejectsWrongState(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodPatch, "/api/v1/agents/"+agentID+"/unarchive", "user", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Agent is not archived") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestDeleteAgentSoftDeletes(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "RETURNING name", rows: &fakeRows{cols: []string{"name"}, rows: [][]any{{"Review Bot"}}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodDelete, "/api/v1/agents/"+agentID, "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &d)
	if d["deleted"] != agentID || d["name"] != "Review Bot" || d["deleted_at"] == nil {
		t.Errorf("delete response: %v", d)
	}
}

func TestRestoreRequiresDeletedRow(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodPatch, "/api/v1/agents/"+agentID+"/restore", "user", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Deleted agent not found") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestCreateAgentReportsMissingFields(t *testing.T) {
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents", "user", "{}")
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

func TestCreateAgentRejectsBadNameAndVisibility(t *testing.T) {
	body := `{"name": "Bad Name!", "version": "1.0.0", "owner": "me",
		"model_name": "m", "description": "d", "visibility": "secret"}`
	rec := serveAgents(t, &fakeDB{}, http.MethodPost, "/api/v1/agents", "user", body)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	if !strings.Contains(out, "value_error") || !strings.Contains(out, "'project' or 'private'") {
		t.Errorf("detail: %s", out)
	}
}

func TestCreateAgentTxFailureMapsTo500(t *testing.T) {
	db := &fakeDB{}
	h := &Handler{Store: &Store{DB: db}, Registry: fakeRegistryStore{}}
	mux := http.NewServeMux()
	withClaims := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := contextWithTestClaims(r.Context())
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	h.Register(mux, withClaims, withClaims)
	body := `{"name": "bot", "version": "1.0.0", "owner": "me", "model_name": "m", "description": "d"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agents", strings.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}
