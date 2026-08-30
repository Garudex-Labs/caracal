// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// errDB fails every store call, driving the handler 500 paths.
type errDB struct{}

type errRow struct{ err error }

func (r errRow) Scan(...any) error { return r.err }

func (errDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("pool down")
}
func (errDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return errRow{errors.New("pool down")}
}
func (errDB) Begin(context.Context) (pgx.Tx, error) { return nil, errors.New("pool down") }

func authed(req *http.Request, role string) *http.Request {
	ctx := httpapi.ContextWithClaims(req.Context(), auth.Claims{UserID: inboxUser, Role: role})
	ctx = tenancy.ContextWithProjectID(ctx, "11111111-1111-1111-1111-111111111111")
	return req.WithContext(ctx)
}

func serveInbox(h *Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body %q: %v", rec.Body.String(), err)
	}
	return out
}

func TestInboxRoutesRequireClaims(t *testing.T) {
	h := &Handler{Store: &Store{DB: &fakeDB{}}}
	for _, target := range []struct{ method, path string }{
		{"GET", "/api/v1/inbox"},
		{"GET", "/api/v1/inbox/count"},
		{"POST", "/api/v1/inbox/read-all"},
		{"POST", "/api/v1/inbox/outdated-report"},
	} {
		rec := serveInbox(h, httptest.NewRequest(target.method, target.path, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s = %d, want 401", target.method, target.path, rec.Code)
		}
	}
}

func TestListEndpoint(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT count(*)", rows: &fakeRows{rows: [][]any{{1}}}},
		{match: "ORDER BY", rows: &fakeRows{rows: [][]any{itemRow("i1", "open", nil)}}},
	}}
	h := &Handler{Store: &Store{DB: db}}
	rec := serveInbox(h, authed(httptest.NewRequest("GET", "/api/v1/inbox?state=open&sort=oldest", nil), "user"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["total"] != float64(1) || body["page"] != float64(1) || body["page_size"] != float64(25) {
		t.Errorf("page envelope: %v", body)
	}
	items := body["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["id"] != "i1" {
		t.Errorf("items: %v", items)
	}
}

func TestListEndpointValidation(t *testing.T) {
	h := &Handler{Store: &Store{DB: &fakeDB{}}}
	cases := []string{
		"/api/v1/inbox?sort=sideways",
		"/api/v1/inbox?page_size=1000",
		"/api/v1/inbox?state=bogus",
		"/api/v1/inbox?kind=bogus",
		"/api/v1/inbox?unread=maybe",
		"/api/v1/inbox?q=" + strings.Repeat("x", 201),
	}
	for _, target := range cases {
		rec := serveInbox(h, authed(httptest.NewRequest("GET", target, nil), "user"))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s = %d, want 422", target, rec.Code)
		}
		if body := decodeBody(t, rec); body["detail"] == nil {
			t.Errorf("%s: 422 without detail: %v", target, body)
		}
	}
}

func TestListEndpointStoreError(t *testing.T) {
	h := &Handler{Store: &Store{DB: errDB{}}}
	rec := serveInbox(h, authed(httptest.NewRequest("GET", "/api/v1/inbox", nil), "user"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestCountEndpoint(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "i.read_at IS NULL", rows: &fakeRows{rows: [][]any{{4}}}},
		{match: "action_required", rows: &fakeRows{rows: [][]any{{2}}}},
		{match: "GROUP BY", rows: &fakeRows{rows: [][]any{{"open", 3}}}},
	}}
	h := &Handler{Store: &Store{DB: db}}
	rec := serveInbox(h, authed(httptest.NewRequest("GET", "/api/v1/inbox/count?facets=true&facet_state=done", nil), "user"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["unread"] != float64(4) || body["action_required"] != float64(2) || body["open"] != float64(3) {
		t.Errorf("badges: %v", body)
	}
	if _, ok := body["by_kind"]; !ok {
		t.Errorf("facets missing: %v", body)
	}

	rec = serveInbox(h, authed(httptest.NewRequest("GET", "/api/v1/inbox/count?facets=maybe", nil), "user"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad facets = %d, want 422", rec.Code)
	}
	rec = serveInbox(h, authed(httptest.NewRequest("GET", "/api/v1/inbox/count?facet_state=bogus", nil), "user"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad facet_state = %d, want 422", rec.Code)
	}
}

func TestCountEndpointStoreError(t *testing.T) {
	h := &Handler{Store: &Store{DB: errDB{}}}
	rec := serveInbox(h, authed(httptest.NewRequest("GET", "/api/v1/inbox/count", nil), "user"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestShowEndpoint(t *testing.T) {
	itemID := uuid.NewString()
	db := &fakeDB{stubs: []stub{
		{match: "i.id = $2", rows: &fakeRows{rows: [][]any{itemRow(itemID, "open", nil)}}},
		{match: "inbox_item_events", rows: &fakeRows{rows: [][]any{
			{"e1", "created", nil, nil, inboxTime},
		}}},
	}}
	h := &Handler{Store: &Store{DB: db}}
	rec := serveInbox(h, authed(httptest.NewRequest("GET", "/api/v1/inbox/"+itemID, nil), "user"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["id"] != itemID {
		t.Errorf("id: %v", body)
	}
	history := body["history"].([]any)
	if len(history) != 1 || history[0].(map[string]any)["event"] != "created" {
		t.Errorf("history: %v", history)
	}
}

func TestShowEndpointErrors(t *testing.T) {
	h := &Handler{Store: &Store{DB: &fakeDB{}}}
	rec := serveInbox(h, authed(httptest.NewRequest("GET", "/api/v1/inbox/not-a-uuid", nil), "user"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad uuid = %d, want 422", rec.Code)
	}
	rec = serveInbox(h, authed(httptest.NewRequest("GET", "/api/v1/inbox/"+uuid.NewString(), nil), "user"))
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing item = %d, want 404", rec.Code)
	}
	broken := &Handler{Store: &Store{DB: errDB{}}}
	rec = serveInbox(broken, authed(httptest.NewRequest("GET", "/api/v1/inbox/"+uuid.NewString(), nil), "user"))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("store failure = %d, want 500", rec.Code)
	}
}

func TestFlipEndpoints(t *testing.T) {
	itemID := uuid.NewString()
	readTime := inboxTime.Add(time.Minute)
	newFlipDB := func(loaded, reloaded []any) *txDB {
		tx := &fakeTx{}
		db := &txDB{tx: tx}
		db.stubs = []stub{
			{match: "i.id = $2", rows: &fakeRows{rows: [][]any{loaded}}},
			{match: "i.id = $1", rows: &fakeRows{rows: [][]any{reloaded}}},
		}
		return db
	}

	// read
	db := newFlipDB(itemRow(itemID, "open", nil), itemRow(itemID, "open", &readTime))
	h := &Handler{Store: &Store{DB: db}}
	rec := serveInbox(h, authed(httptest.NewRequest("POST", "/api/v1/inbox/"+itemID+"/read", nil), "user"))
	if rec.Code != http.StatusOK {
		t.Fatalf("read status = %d: %s", rec.Code, rec.Body.String())
	}
	if body := decodeBody(t, rec); body["read"] != true {
		t.Errorf("read projection: %v", body)
	}

	// unread
	db = newFlipDB(itemRow(itemID, "open", &readTime), itemRow(itemID, "open", nil))
	h = &Handler{Store: &Store{DB: db}}
	rec = serveInbox(h, authed(httptest.NewRequest("POST", "/api/v1/inbox/"+itemID+"/unread", nil), "user"))
	if rec.Code != http.StatusOK || decodeBody(t, rec)["read"] != false {
		t.Errorf("unread = %d: %s", rec.Code, rec.Body.String())
	}

	// done
	db = newFlipDB(itemRow(itemID, "open", nil), itemRow(itemID, "done", nil))
	h = &Handler{Store: &Store{DB: db}}
	rec = serveInbox(h, authed(httptest.NewRequest("POST", "/api/v1/inbox/"+itemID+"/done", nil), "user"))
	if rec.Code != http.StatusOK || decodeBody(t, rec)["state"] != "done" {
		t.Errorf("done = %d: %s", rec.Code, rec.Body.String())
	}

	// reopen on an already-open item is a store no-op returning the item.
	db = newFlipDB(itemRow(itemID, "open", nil), itemRow(itemID, "open", nil))
	h = &Handler{Store: &Store{DB: db}}
	rec = serveInbox(h, authed(httptest.NewRequest("POST", "/api/v1/inbox/"+itemID+"/reopen", nil), "user"))
	if rec.Code != http.StatusOK || decodeBody(t, rec)["state"] != "open" {
		t.Errorf("reopen = %d: %s", rec.Code, rec.Body.String())
	}
	if len(db.tx.log) != 0 {
		t.Errorf("no-op reopen wrote: %v", db.tx.log)
	}

	// dismiss with a failing transaction begin reports 500.
	failing := &txDB{beginErr: errors.New("pool down")}
	failing.stubs = []stub{
		{match: "i.id = $2", rows: &fakeRows{rows: [][]any{itemRow(itemID, "open", nil)}}},
	}
	h = &Handler{Store: &Store{DB: failing}}
	rec = serveInbox(h, authed(httptest.NewRequest("POST", "/api/v1/inbox/"+itemID+"/dismiss", nil), "user"))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("dismiss with dead pool = %d, want 500", rec.Code)
	}
}

func TestReadAllEndpoint(t *testing.T) {
	tx := &fakeTx{}
	db := &txDB{tx: tx}
	db.stubs = []stub{
		{match: "SELECT i.id::text", rows: &fakeRows{rows: [][]any{{"a"}, {"b"}}}},
	}
	h := &Handler{Store: &Store{DB: db}}
	rec := serveInbox(h, authed(httptest.NewRequest("POST", "/api/v1/inbox/read-all?kind=system_notice", nil), "user"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if body := decodeBody(t, rec); body["updated"] != float64(2) {
		t.Errorf("updated: %v", body)
	}

	rec = serveInbox(h, authed(httptest.NewRequest("POST", "/api/v1/inbox/read-all?state=bogus", nil), "user"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad filter = %d, want 422", rec.Code)
	}

	broken := &Handler{Store: &Store{DB: errDB{}}}
	rec = serveInbox(broken, authed(httptest.NewRequest("POST", "/api/v1/inbox/read-all", nil), "user"))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("store failure = %d, want 500", rec.Code)
	}
}

// -- outdated-report ---------------------------------------------------------

func outdatedReportBody(items ...map[string]any) io.Reader {
	raw, _ := json.Marshal(map[string]any{"items": items})
	return strings.NewReader(string(raw))
}

func reportItem(overrides map[string]any) map[string]any {
	item := map[string]any{
		"type":            "mcp",
		"component_id":    "33333333-3333-3333-3333-333333333333",
		"name":            "server",
		"namespace":       "acme",
		"slug":            "tool",
		"current_version": "1.0.0",
		"latest_version":  "1.1.0",
		"harness":         "kiro",
	}
	for k, v := range overrides {
		if v == nil {
			delete(item, k)
		} else {
			item[k] = v
		}
	}
	return item
}

func TestOutdatedReportEndpoint(t *testing.T) {
	tx := &fakeTx{stubs: []stub{
		{match: "ON CONFLICT", rows: &fakeRows{rows: [][]any{{"new-id"}}}},
	}}
	db := &txDB{tx: tx}
	h := &Handler{Store: &Store{DB: db}}
	rec := serveInbox(h, authed(httptest.NewRequest("POST", "/api/v1/inbox/outdated-report",
		outdatedReportBody(reportItem(nil))), "user"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["created"] != float64(1) || body["superseded"] != float64(0) {
		t.Errorf("counters: %v", body)
	}
}

func TestOutdatedReportValidation(t *testing.T) {
	h := &Handler{Store: &Store{DB: &fakeDB{}}}
	post := func(body io.Reader) *httptest.ResponseRecorder {
		return serveInbox(h, authed(httptest.NewRequest("POST", "/api/v1/inbox/outdated-report", body), "user"))
	}

	if rec := post(strings.NewReader("not json")); rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("garbage body = %d, want 422", rec.Code)
	}

	tooMany := make([]map[string]any, 201)
	for i := range tooMany {
		tooMany[i] = reportItem(nil)
	}
	if rec := post(outdatedReportBody(tooMany...)); rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("201 items = %d, want 422", rec.Code)
	}

	invalid := []map[string]any{
		reportItem(map[string]any{"component_id": nil}),
		reportItem(map[string]any{"type": "MCP!"}),
		reportItem(map[string]any{"namespace": "../escape"}),
		reportItem(map[string]any{"slug": "bad slug"}),
		reportItem(map[string]any{"current_version": ""}),
		reportItem(map[string]any{"latest_version": "1.0 OR 1=1"}),
		reportItem(map[string]any{"harness": "kiro; rm"}),
	}
	for i, item := range invalid {
		rec := post(outdatedReportBody(item))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("invalid item %d = %d, want 422: %s", i, rec.Code, rec.Body.String())
		}
	}
}

func TestOutdatedReportStoreError(t *testing.T) {
	db := &txDB{beginErr: errors.New("pool down")}
	h := &Handler{Store: &Store{DB: db}}
	rec := serveInbox(h, authed(httptest.NewRequest("POST", "/api/v1/inbox/outdated-report",
		outdatedReportBody(reportItem(nil))), "user"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestOutdatedReportRateLimit(t *testing.T) {
	h := &Handler{Store: &Store{DB: &fakeDB{}}}
	var last *httptest.ResponseRecorder
	for i := 0; i < 11; i++ {
		req := httptest.NewRequest("POST", "/api/v1/inbox/outdated-report", strings.NewReader("{}"))
		req.Header.Set("Authorization", "Bearer same-token")
		last = serveInbox(h, authed(req, "user"))
	}
	if last.Code != http.StatusTooManyRequests {
		t.Fatalf("11th request = %d, want 429", last.Code)
	}
	if last.Header().Get("Retry-After") != "60" {
		t.Errorf("Retry-After = %q", last.Header().Get("Retry-After"))
	}
}

// -- rate limiter internals --------------------------------------------------

func TestRateKey(t *testing.T) {
	req := httptest.NewRequest("POST", "/", nil)
	req.Header.Set("Authorization", "Bearer abc")
	tokenKey := rateKey(req)
	if !strings.HasPrefix(tokenKey, "token:") {
		t.Errorf("bearer key = %q", tokenKey)
	}
	// The raw token must not appear in the key.
	if strings.Contains(tokenKey, "abc") {
		t.Errorf("token leaked into key: %q", tokenKey)
	}

	req = httptest.NewRequest("POST", "/", nil)
	req.Header.Set("X-Real-IP", "203.0.113.9")
	if got := rateKey(req); got != "ip:203.0.113.9" {
		t.Errorf("real-ip key = %q", got)
	}

	req = httptest.NewRequest("POST", "/", nil)
	if got := rateKey(req); !strings.HasPrefix(got, "ip:") {
		t.Errorf("fallback key = %q", got)
	}
}

func TestRateWindowAllow(t *testing.T) {
	var w rateWindow
	if !w.allow("k", 1, time.Hour) {
		t.Fatal("first hit must pass")
	}
	if w.allow("k", 1, time.Hour) {
		t.Fatal("second hit within the window must be rejected")
	}
	// A non-positive window expires everything, so hits always pass.
	var expired rateWindow
	if !expired.allow("k", 1, -time.Second) || !expired.allow("k", 1, -time.Second) {
		t.Fatal("expired entries must be evicted")
	}
}

func TestWireTimeKeepsMicroseconds(t *testing.T) {
	ts := time.Date(2026, 8, 30, 10, 0, 0, 123456000, time.UTC)
	if got := wireTime(ts); got != "2026-08-30T10:00:00.123456Z" {
		t.Errorf("wireTime = %q", got)
	}
}
