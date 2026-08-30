// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/harness"
	"github.com/garudex-labs/caracal/internal/httpapi"

	"github.com/garudex-labs/caracal/internal/settings"
)

type fakeStore struct {
	listRows    []map[string]any
	listFilter  ListFilter
	queryPage   *QueryPage
	queryErr    error
	queryFilter QueryFilter
	summaryRow  map[string]any
	summaryProj string
	summaryUser string
	statsRow    map[string]any
	statsCalls  int
	identity    map[string]any
	rows        []map[string]any
	subRows     []map[string]any
	owns        bool
}

func (f *fakeStore) ListSessions(_ context.Context, filter ListFilter) ([]map[string]any, error) {
	f.listFilter = filter
	return f.listRows, nil
}
func (f *fakeStore) QuerySessions(_ context.Context, filter QueryFilter) (*QueryPage, error) {
	f.queryFilter = filter
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	if f.queryPage != nil {
		return f.queryPage, nil
	}
	return &QueryPage{Items: []map[string]any{}}, nil
}
func (f *fakeStore) Summary(_ context.Context, projectID, userID string) (map[string]any, error) {
	f.summaryProj = projectID
	f.summaryUser = userID
	return f.summaryRow, nil
}
func (f *fakeStore) Stats(context.Context) (map[string]any, error) {
	f.statsCalls++
	return f.statsRow, nil
}
func (f *fakeStore) SessionIdentity(context.Context, string, string, string) (map[string]any, error) {
	return f.identity, nil
}
func (f *fakeStore) SessionRows(context.Context, Identity, *int64) ([]map[string]any, error) {
	return f.rows, nil
}
func (f *fakeStore) SubagentRows(context.Context, Identity, *int64) ([]map[string]any, error) {
	return f.subRows, nil
}
func (f *fakeStore) OwnsSession(context.Context, string, string, string) (bool, error) {
	return f.owns, nil
}

type fakeProjects struct{ id string }

func (f fakeProjects) ResolveProjectID(context.Context, *http.Request, uuid.UUID) (string, error) {
	if f.id == "" {
		return "project-test", nil
	}
	return f.id, nil
}

type fakeDir struct {
	users  map[string]string
	agents map[string]string
	caller string
	filter []string
}

func (f *fakeDir) UserNames(_ context.Context, _ []string) map[string]string  { return f.users }
func (f *fakeDir) AgentNames(_ context.Context, _ []string) map[string]string { return f.agents }
func (f *fakeDir) UserName(context.Context, uuid.UUID) string                 { return f.caller }
func (f *fakeDir) ResolveUserFilter(context.Context, string) []string         { return f.filter }

type fakeSettings struct {
	tracePrivacy bool
}

func (f fakeSettings) Bool(_ context.Context, key string, fallback bool) bool {
	if key == "security.trace_privacy" {
		return f.tracePrivacy
	}
	return fallback
}
func (f fakeSettings) Int(_ context.Context, _ string, fallback int) int { return fallback }

func (f fakeSettings) String(_ context.Context, _, fallback string) string { return fallback }

type fakeBinder struct {
	err  error
	key  string
	name string
}

func (f *fakeBinder) BindAgent(_ context.Context, sessionID, agentName string) error {
	f.key, f.name = sessionID, agentName
	return f.err
}

func newHandler(store *fakeStore, dir *fakeDir, cfg settings.Reader, binder *fakeBinder) *Handler {
	return &Handler{
		Store:    store,
		Dir:      dir,
		Settings: cfg,
		Registry: harness.MustLoad(),
		Binder:   binder,
		Projects: fakeProjects{},
	}
}

func do(h *Handler, role string, userID uuid.UUID, method, target string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	claims := auth.Claims{UserID: userID, Role: role}
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(), claims))
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func doOperator(h *Handler, role string, userID uuid.UUID, method, target string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	claims := auth.Claims{UserID: userID, Role: role}
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(), claims))
	rec := httptest.NewRecorder()
	h.OperatorRoutes().ServeHTTP(rec, req)
	return rec
}

func decodeList(t *testing.T, rec *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	var out []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v (%s)", err, rec.Body.String())
	}
	return out
}

func decodeMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v (%s)", err, rec.Body.String())
	}
	return out
}

func TestListSessionsScopesAndMunges(t *testing.T) {
	userID := uuid.New()
	store := &fakeStore{listRows: []map[string]any{{
		"session_id": "s1", "user_id": userID.String(), "harness": "kiro",
		"is_active": float64(1), "agent_id": "", "agent_version": "",
		"prompt_count": "3",
	}}}
	dir := &fakeDir{users: map[string]string{}, agents: map[string]string{}, caller: "Caller Name"}
	h := newHandler(store, dir, fakeSettings{}, &fakeBinder{})

	rec := do(h, "user", userID, http.MethodGet, "/api/v1/sessions")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !store.listFilter.OwnerOnly || store.listFilter.OwnerID != userID.String() {
		t.Errorf("non-admin must be owner-scoped: %+v", store.listFilter)
	}
	rows := decodeList(t, rec)
	row := rows[0]
	checks := map[string]any{
		"platform":     "Kiro",
		"service_name": "kiro",
		"is_active":    true,
		"user_name":    "Caller Name",
		"agent_id":     nil,
		"agent_name":   nil,
		"prompt_count": "3", // 64-bit counters stay in their wire form
	}
	for key, want := range checks {
		if got := row[key]; got != want {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}
	if _, stillThere := row["harness"]; stillThere {
		t.Error("harness column must be replaced by platform/service_name")
	}
}

func TestListSessionsAdminScopeAndPrivacy(t *testing.T) {
	store := &fakeStore{}
	h := newHandler(store, &fakeDir{}, fakeSettings{tracePrivacy: false}, &fakeBinder{})
	do(h, "operator", uuid.New(), http.MethodGet, "/api/v1/sessions")
	if store.listFilter.OwnerOnly {
		t.Error("operator without trace privacy sees all sessions")
	}

	h = newHandler(store, &fakeDir{}, fakeSettings{tracePrivacy: true}, &fakeBinder{})
	do(h, "operator", uuid.New(), http.MethodGet, "/api/v1/sessions")
	if !store.listFilter.OwnerOnly {
		t.Error("trace privacy scopes operators to their own sessions")
	}

	h = newHandler(store, &fakeDir{}, fakeSettings{tracePrivacy: true}, &fakeBinder{})
	do(h, "super_admin", uuid.New(), http.MethodGet, "/api/v1/sessions")
	if !store.listFilter.OwnerOnly {
		t.Error("legacy role names carry no cross-user access")
	}
}

func TestListSessionsUserFilterShortCircuit(t *testing.T) {
	store := &fakeStore{listRows: []map[string]any{{"session_id": "x"}}}
	h := newHandler(store, &fakeDir{filter: nil}, fakeSettings{}, &fakeBinder{})
	rec := do(h, "operator", uuid.New(), http.MethodGet, "/api/v1/sessions?user=nobody")
	if body := rec.Body.String(); body != "[]\n" {
		t.Errorf("unmatched user filter returns an empty list, got %q", body)
	}
}

func TestListSessionsValidation(t *testing.T) {
	h := newHandler(&fakeStore{}, &fakeDir{}, fakeSettings{}, &fakeBinder{})
	for _, target := range []string{
		"/api/v1/sessions?limit=0",
		"/api/v1/sessions?limit=201",
		"/api/v1/sessions?offset=-1",
		"/api/v1/sessions?days=abc",
	} {
		rec := do(h, "user", uuid.New(), http.MethodGet, target)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422", target, rec.Code)
		}
	}
}

func TestListSessionsDaysCap(t *testing.T) {
	store := &fakeStore{}
	h := newHandler(store, &fakeDir{}, fakeSettings{}, &fakeBinder{})
	do(h, "user", uuid.New(), http.MethodGet, "/api/v1/sessions?days=9999")
	if store.listFilter.Days != 365 {
		t.Errorf("days = %d, want capped 365", store.listFilter.Days)
	}
}

func TestQuerySessionsEnvelopeAndScope(t *testing.T) {
	userID := uuid.New()
	store := &fakeStore{queryPage: &QueryPage{
		Items: []map[string]any{{
			"session_id": "s1", "user_id": userID.String(), "harness": "kiro",
			"is_active": float64(1), "agent_id": "", "agent_version": "",
			"duration_s": "95", "total_tokens": "12000",
		}},
		Total: 41, P95DurationS: 90.5, P95Tokens: 11000,
	}}
	dir := &fakeDir{users: map[string]string{}, agents: map[string]string{}, caller: "Caller"}
	h := newHandler(store, dir, fakeSettings{}, &fakeBinder{})

	rec := do(h, "user", userID, http.MethodGet,
		"/api/v1/sessions/query?q=kiro&platform=kiro&model=sonnet&status=active&sort=duration&days=7&min_duration=60&min_tokens=100&page=2&page_size=10")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	got := store.queryFilter
	want := QueryFilter{
		ProjectID: "project-test",
		Search:    "kiro", Platform: "kiro", Model: "sonnet", Status: "active",
		Sort: "duration", Days: 7, MinDurationS: 60, MinTokens: 100,
		OwnerOnly: true, OwnerID: userID.String(), Limit: 10, Offset: 10,
	}
	if fmt.Sprintf("%+v", got) != fmt.Sprintf("%+v", want) {
		t.Errorf("filter = %+v, want %+v", got, want)
	}
	body := decodeMap(t, rec)
	if body["total"] != float64(41) || body["page"] != float64(2) || body["page_size"] != float64(10) {
		t.Errorf("result context wrong: %v", body)
	}
	if body["p95_duration_s"] != 90.5 || body["p95_total_tokens"] != float64(11000) {
		t.Errorf("window percentiles wrong: %v", body)
	}
	items, _ := body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %v", body["items"])
	}
	row, _ := items[0].(map[string]any)
	if row["platform"] != "Kiro" || row["service_name"] != "kiro" || row["is_active"] != true {
		t.Errorf("rows must be decorated: %v", row)
	}
}

func TestQuerySessionsValidation(t *testing.T) {
	h := newHandler(&fakeStore{}, &fakeDir{}, fakeSettings{}, &fakeBinder{})
	for _, target := range []string{
		"/api/v1/sessions/query?page=0",
		"/api/v1/sessions/query?page_size=101",
		"/api/v1/sessions/query?sort=bogus",
		"/api/v1/sessions/query?status=failed",
		"/api/v1/sessions/query?min_duration=-1",
		"/api/v1/sessions/query?min_tokens=-1",
		"/api/v1/sessions/query?days=400",
		"/api/v1/sessions/query?page=51&page_size=100",
	} {
		rec := do(h, "user", uuid.New(), http.MethodGet, target)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422", target, rec.Code)
		}
	}
}

func TestQuerySessionsAdminScopeAndMine(t *testing.T) {
	store := &fakeStore{}
	h := newHandler(store, &fakeDir{}, fakeSettings{}, &fakeBinder{})
	adminID := uuid.New()
	do(h, "operator", adminID, http.MethodGet, "/api/v1/sessions/query")
	if store.queryFilter.OwnerOnly {
		t.Error("operator without trace privacy queries all sessions")
	}
	do(h, "operator", adminID, http.MethodGet, "/api/v1/sessions/query?mine=true")
	if !store.queryFilter.OwnerOnly || store.queryFilter.OwnerID != adminID.String() {
		t.Errorf("mine pins the owner: %+v", store.queryFilter)
	}
}

func TestQuerySessionsUserFilterShortCircuit(t *testing.T) {
	store := &fakeStore{queryPage: &QueryPage{Total: 9}}
	h := newHandler(store, &fakeDir{filter: nil}, fakeSettings{}, &fakeBinder{})
	rec := do(h, "operator", uuid.New(), http.MethodGet, "/api/v1/sessions/query?user=nobody")
	body := decodeMap(t, rec)
	if body["total"] != float64(0) {
		t.Errorf("unmatched user filter returns the empty envelope, got %v", body)
	}
	if items, _ := body["items"].([]any); len(items) != 0 {
		t.Errorf("items = %v, want empty", body["items"])
	}
}

func TestQuerySessionsStoreErrorIsNotSilent(t *testing.T) {
	store := &fakeStore{queryErr: errors.New("clickhouse down")}
	h := newHandler(store, &fakeDir{}, fakeSettings{}, &fakeBinder{})
	rec := do(h, "user", uuid.New(), http.MethodGet, "/api/v1/sessions/query")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

func TestSummaryScoping(t *testing.T) {
	store := &fakeStore{summaryRow: map[string]any{"total": "7", "today_sessions": float64(2)}}
	h := newHandler(store, &fakeDir{}, fakeSettings{}, &fakeBinder{})
	userID := uuid.New()
	rec := do(h, "user", userID, http.MethodGet, "/api/v1/sessions/summary")
	if store.summaryUser != userID.String() {
		t.Errorf("summary must be user-scoped for non-admins, got %q", store.summaryUser)
	}
	out := decodeMap(t, rec)
	if out["total_sessions"] != float64(7) || out["today_sessions"] != float64(2) {
		t.Errorf("summary = %v", out)
	}
}

func TestStatsRequiresOperatorAndCaches(t *testing.T) {
	store := &fakeStore{statsRow: map[string]any{"total_sessions": "5"}}
	h := newHandler(store, &fakeDir{}, fakeSettings{}, &fakeBinder{})

	rec := doOperator(h, "user", uuid.New(), http.MethodGet, "/api/v1/operator/sessions/stats")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("user role status = %d, want 403", rec.Code)
	}

	rec = doOperator(h, "operator", uuid.New(), http.MethodGet, "/api/v1/operator/sessions/stats")
	if rec.Code != http.StatusOK {
		t.Fatalf("operator status = %d", rec.Code)
	}
	if out := decodeMap(t, rec); out["total_sessions"] != float64(5) {
		t.Errorf("stats = %v", out)
	}
	doOperator(h, "operator", uuid.New(), http.MethodGet, "/api/v1/operator/sessions/stats")
	if store.statsCalls != 1 {
		t.Errorf("stats queries = %d, want 1 (cached)", store.statsCalls)
	}
}

func TestGetSessionNotVisible(t *testing.T) {
	h := newHandler(&fakeStore{identity: nil}, &fakeDir{}, fakeSettings{}, &fakeBinder{})
	rec := do(h, "user", uuid.New(), http.MethodGet, "/api/v1/sessions/missing-one")
	out := decodeMap(t, rec)
	if out["harness"] != "" || len(out["events"].([]any)) != 0 {
		t.Errorf("invisible session must return the empty shape: %v", out)
	}
}

func TestGetSessionRendersEventsAndSubagents(t *testing.T) {
	raw := `{"type":"user","timestamp":"2026-01-05T10:00:00.000Z","message":{"content":"hello there"}}`
	identity := map[string]any{"project_id": "p1", "user_id": "u1", "harness": "claude-code"}
	mainRows := []map[string]any{{
		"session_id": "s1", "harness": "claude-code", "line_offset": float64(4),
		"timestamp": "2026-01-05 10:00:00.000", "ingested_at": "2026-01-05 10:00:01.000",
		"event_type": "user_prompt", "content_preview": "hello there", "content_length": float64(11),
		"raw_line": raw, "agent_id": "", "agent_version": "", "credits": float64(0),
		"uuid": nil, "parent_uuid": nil, "tool_name": nil, "tool_id": nil,
	}}
	subRows := []map[string]any{{
		"session_id": "child-1", "harness": "claude-code", "line_offset": float64(0),
		"timestamp": "2026-01-05 10:00:02.000", "ingested_at": "2026-01-05 10:00:03.000",
		"event_type": "user_prompt", "content_preview": "sub", "content_length": float64(3),
		"raw_line": raw, "parent_uuid": "spawn-uuid", "uuid": nil, "tool_name": nil, "tool_id": nil,
		"credits": float64(0),
	}}
	store := &fakeStore{identity: identity, rows: mainRows, subRows: subRows}
	h := newHandler(store, &fakeDir{agents: map[string]string{}}, fakeSettings{}, &fakeBinder{})

	rec := do(h, "user", uuid.New(), http.MethodGet, "/api/v1/sessions/s1")
	out := decodeMap(t, rec)
	if out["service_name"] != "claude-code" || out["max_offset"] != float64(4) {
		t.Errorf("header fields = %v / %v", out["service_name"], out["max_offset"])
	}
	events := out["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	first := events[0].(map[string]any)
	if first["event_name"] != "hook_userpromptsubmit" || first["body"] != "hello there" {
		t.Errorf("rendered event = %v", first)
	}
	subs := out["subagent_sessions"].([]any)
	if len(subs) != 1 {
		t.Fatalf("subagent_sessions = %d, want 1", len(subs))
	}
	sub := subs[0].(map[string]any)
	if sub["session_id"] != "child-1" || sub["spawned_by"] != "spawn-uuid" {
		t.Errorf("subagent = %v", sub)
	}
}

func TestBindAgent(t *testing.T) {
	binder := &fakeBinder{}
	h := newHandler(&fakeStore{owns: true}, &fakeDir{}, fakeSettings{}, binder)
	rec := do(h, "user", uuid.New(), http.MethodPost, "/api/v1/sessions/s9/bind-agent?agent_name=helper")
	out := decodeMap(t, rec)
	if out["bound"] != true || binder.key != "s9" || binder.name != "helper" {
		t.Errorf("bind result = %v (key=%q name=%q)", out, binder.key, binder.name)
	}

	// Non-owner is denied with 404.
	h = newHandler(&fakeStore{owns: false}, &fakeDir{}, fakeSettings{}, binder)
	rec = do(h, "user", uuid.New(), http.MethodPost, "/api/v1/sessions/s9/bind-agent?agent_name=helper")
	if rec.Code != http.StatusNotFound {
		t.Errorf("non-owner status = %d, want 404", rec.Code)
	}

	// Missing agent_name is a validation error.
	rec = do(h, "user", uuid.New(), http.MethodPost, "/api/v1/sessions/s9/bind-agent")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing agent_name status = %d, want 422", rec.Code)
	}

	// Binding failures degrade gracefully.
	h = newHandler(&fakeStore{owns: true}, &fakeDir{}, fakeSettings{}, &fakeBinder{err: errors.New("down")})
	rec = do(h, "user", uuid.New(), http.MethodPost, "/api/v1/sessions/s9/bind-agent?agent_name=helper")
	out = decodeMap(t, rec)
	if out["bound"] != false || out["error"] != "Redis unavailable" {
		t.Errorf("degraded bind = %v", out)
	}
}
