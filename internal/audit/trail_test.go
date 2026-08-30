// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// trailBackend fakes the analytics store for read queries.
type trailBackend struct {
	rows    []map[string]any
	fail    bool
	lastSQL string
	lastQS  map[string][]string
}

func (b *trailBackend) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	b.lastSQL = string(body)
	b.lastQS = r.URL.Query()
	if b.fail {
		http.Error(w, "boom", http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": b.rows})
}

func trailRow(overrides map[string]any) map[string]any {
	row := map[string]any{
		"event_id": "0a0a0a0a-0000-0000-0000-000000000001", "timestamp": "2026-05-01 10:00:00.000",
		"actor_id": "u-1", "actor_email": "a@example.com", "actor_role": "admin",
		"action": "get./x", "resource_type": "", "resource_id": "", "resource_name": "",
		"http_method": "GET", "http_path": "/x", "status_code": float64(200),
		"ip_address": "10.0.0.9", "user_agent": "ua", "detail": "",
		"sensitivity": "standard", "request_id": "r-1", "outcome": "success",
		"duration_ms": float64(0), "chain_hash": "abc", "source": "server",
	}
	for k, v := range overrides {
		row[k] = v
	}
	return row
}

func newTrail(t *testing.T, backend *trailBackend) *Trail {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(backend.handler))
	t.Cleanup(server.Close)
	client, err := clickhouse.New(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return &Trail{
		CH:         client,
		now:        func() time.Time { return time.Date(2026, 5, 2, 8, 0, 0, 0, time.UTC) },
		userFilter: func(context.Context, string) ([]string, []string) { return nil, nil },
	}
}

func doTrail(t *testing.T, tr *Trail, path, role string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(), auth.Claims{
		UserID: uuid.MustParse("22222222-2222-2222-2222-222222222222"), Role: role,
	}))
	rec := httptest.NewRecorder()
	tr.Routes().ServeHTTP(rec, req)
	return rec
}

func TestTrailListShape(t *testing.T) {
	backend := &trailBackend{rows: []map[string]any{trailRow(nil), trailRow(map[string]any{"duration_ms": float64(12.5)})}}
	tr := newTrail(t, backend)
	rec := doTrail(t, tr, "/api/v1/operator/audit-log", "operator")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"duration_ms":0.0`) || !strings.Contains(body, `"duration_ms":12.5`) {
		t.Fatalf("duration wire form: %s", body)
	}
	if !strings.HasPrefix(body, `[{"event_id":`) {
		t.Fatalf("field order: %s", body[:60])
	}
	if !strings.Contains(backend.lastSQL, "LIMIT {lim:UInt32} OFFSET {off:UInt32}") {
		t.Fatalf("sql: %s", backend.lastSQL)
	}
	if got := backend.lastQS["param_lim"]; len(got) != 1 || got[0] != "50" {
		t.Fatalf("default limit param: %v", backend.lastQS)
	}
}

func TestTrailListFilters(t *testing.T) {
	backend := &trailBackend{}
	tr := newTrail(t, backend)
	tr.userFilter = func(_ context.Context, q string) ([]string, []string) {
		if q != "richard" {
			t.Fatalf("actor query = %q", q)
		}
		return []string{"id-1", "id-2"}, []string{"richard@example.com"}
	}
	rec := doTrail(t, tr, "/api/v1/operator/audit-log?actor=richard&action=login&source=cli&start_date=2026-05-01T00:00:00&limit=10&offset=5", "operator")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	sql := backend.lastSQL
	for _, want := range []string{
		"(actor_id IN ({actor_id_0:String}, {actor_id_1:String}) OR actor_email IN ({actor_email_0:String}))",
		"action = {action:String}", "source = {src:String}", "timestamp >= {start:String}",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("missing %q in %s", want, sql)
		}
	}
	qs := backend.lastQS
	for key, want := range map[string]string{
		"param_actor_id_0": "id-1", "param_actor_email_0": "richard@example.com",
		"param_action": "login", "param_src": "cli",
		"param_start": "2026-05-01 00:00:00", "param_lim": "10", "param_off": "5",
	} {
		if got := qs[key]; len(got) != 1 || got[0] != want {
			t.Errorf("%s = %v, want %s", key, got, want)
		}
	}
}

func TestTrailActorFallback(t *testing.T) {
	backend := &trailBackend{}
	tr := newTrail(t, backend)
	rec := doTrail(t, tr, "/api/v1/operator/audit-log?actor=ghost@example.com", "operator")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(backend.lastSQL, "actor_email = {actor:String}") {
		t.Fatalf("fallback missing: %s", backend.lastSQL)
	}
}

func TestTrailValidationAndRole(t *testing.T) {
	tr := newTrail(t, &trailBackend{})
	if rec := doTrail(t, tr, "/api/v1/operator/audit-log?limit=0", "operator"); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("limit=0: %d", rec.Code)
	}
	if rec := doTrail(t, tr, "/api/v1/operator/audit-log?limit=501", "operator"); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("limit=501: %d", rec.Code)
	}
	if rec := doTrail(t, tr, "/api/v1/operator/audit-log?start_date=yesterday", "operator"); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad date: %d", rec.Code)
	}
	if rec := doTrail(t, tr, "/api/v1/operator/audit-log", "user"); rec.Code != http.StatusForbidden {
		t.Fatalf("user role: %d", rec.Code)
	}
	if rec := doTrail(t, tr, "/api/v1/operator/audit-log/export", "reviewer"); rec.Code != http.StatusForbidden {
		t.Fatalf("reviewer export: %d", rec.Code)
	}
}

func TestTrailStorageFailureReadsEmpty(t *testing.T) {
	tr := newTrail(t, &trailBackend{fail: true})
	rec := doTrail(t, tr, "/api/v1/operator/audit-log", "operator")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("failure contract: %d %s", rec.Code, rec.Body.String())
	}
}

func TestTrailExportCSV(t *testing.T) {
	backend := &trailBackend{rows: []map[string]any{trailRow(map[string]any{"detail": `has,comma "q"`})}}
	tr := newTrail(t, backend)
	rec := doTrail(t, tr, "/api/v1/operator/audit-log/export", "operator")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Disposition"); got != "attachment; filename=caracal_audit-log_20260502T080000Z.csv" {
		t.Fatalf("disposition: %s", got)
	}
	lines := strings.Split(rec.Body.String(), "\r\n")
	if lines[0] != strings.Join(trailFieldnames, ",") {
		t.Fatalf("header: %s", lines[0])
	}
	if !strings.Contains(lines[1], `"has,comma ""q"""`) || !strings.Contains(lines[1], ",200,") {
		t.Fatalf("row: %s", lines[1])
	}
	if !strings.Contains(backend.lastSQL, "LIMIT 10000") {
		t.Fatalf("sql: %s", backend.lastSQL)
	}
}

func TestTrailExportJSON(t *testing.T) {
	backend := &trailBackend{rows: []map[string]any{trailRow(map[string]any{"detail": "caf\u00e9"})}}
	tr := newTrail(t, backend)
	rec := doTrail(t, tr, "/api/v1/operator/audit-log/export?format=json", "operator")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Disposition"); got != "attachment; filename=caracal_audit-log_20260502T080000Z.json" {
		t.Fatalf("disposition: %s", got)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"exported_at": "2026-05-02T08:00:00"`) || !strings.Contains(body, `"record_count": 1`) {
		t.Fatalf("envelope: %s", body)
	}
	if !strings.Contains(body, `"duration_ms": 0`) || strings.Contains(body, `"duration_ms": 0.0`) {
		t.Fatalf("raw duration form: %s", body)
	}
	if !strings.Contains(body, `caf\u00e9`) {
		t.Fatalf("ascii escaping: %s", body)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("invalid json after escaping: %v", err)
	}
}

func TestAsciiEscapeSurrogates(t *testing.T) {
	out := string(asciiEscape([]byte("\U0001F600")))
	if out != `\ud83d\ude00` {
		t.Fatalf("surrogate pair: %s", out)
	}
}
