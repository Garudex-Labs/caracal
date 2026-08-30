// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/settings"
)

func TestRegisterAppliesRoleFloors(t *testing.T) {
	h := &Handler{}
	mux := http.NewServeMux()
	// Tagging middlewares that never call next prove which floor wraps
	// each route without exercising the handlers.
	floor := func(name string) func(http.Handler) http.Handler {
		return func(http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("X-Floor", name)
			})
		}
	}
	h.Register(mux, floor("operator"), floor("user"))

	cases := []struct{ method, path, want string }{
		{"GET", "/api/v1/operator/status", "operator"},
		{"POST", "/api/v1/operator/resources/apply", "operator"},
		{"GET", "/api/v1/operator/ai-engine/models/providers", "operator"},
		{"GET", "/api/v1/operator/ai-engine/models", "operator"},
		{"POST", "/api/v1/operator/ai-engine/test-connection", "operator"},
		{"GET", "/api/v1/operator/security-events", "operator"},
		{"GET", "/api/v1/operator/trace-privacy", "operator"},
		{"PUT", "/api/v1/operator/trace-privacy", "operator"},
		{"GET", "/api/v1/operator/registered-agents-only", "user"},
		{"PUT", "/api/v1/operator/registered-agents-only", "operator"},
		{"POST", "/api/v1/operator/cache/clear", "operator"},
		{"GET", "/api/v1/operator/restart/status", "operator"},
		{"POST", "/api/v1/operator/restart", "operator"},
		{"GET", "/api/v1/operator/settings", "operator"},
		{"GET", "/api/v1/operator/settings/schema", "operator"},
		{"PUT", "/api/v1/operator/settings/some.key", "operator"},
		{"DELETE", "/api/v1/operator/settings/some.key", "operator"},
		{"POST", "/api/v1/operator/settings/some.key/revoke", "operator"},
		{"POST", "/api/v1/operator/settings/danger/purge-traces-insights", "operator"},
		{"GET", "/api/v1/operator/system-warnings", "operator"},
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if got := w.Header().Get("X-Floor"); got != tc.want {
			t.Errorf("%s %s routed through floor %q, want %q", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestUserFilterValues(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/v1/operator/security-events", nil)

	t.Run("uuid input becomes an id filter", func(t *testing.T) {
		db := &fakeDB{}
		h := &Handler{DB: db}
		ids, emails, err := h.userFilterValues(req, " 33333333-3333-3333-3333-333333333333 ")
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) != 1 || ids[0] != "33333333-3333-3333-3333-333333333333" {
			t.Errorf("ids = %v", ids)
		}
		if len(emails) != 0 {
			t.Errorf("emails = %v", emails)
		}
	})

	t.Run("email input merges with search hits deduped", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{{match: "WITH scored AS", rows: [][]any{
			{testAdminID, "admin@example.com"},
			{testAdminID, "admin@example.com"},
		}}}}
		h := &Handler{DB: db}
		ids, emails, err := h.userFilterValues(req, " Admin@Example.com ")
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) != 1 || ids[0] != testAdminID.String() {
			t.Errorf("ids = %v", ids)
		}
		if len(emails) != 1 || emails[0] != "admin@example.com" {
			t.Errorf("emails = %v", emails)
		}
	})

	t.Run("short query never contacts storage", func(t *testing.T) {
		db := &fakeDB{}
		h := &Handler{DB: db}
		ids, emails, err := h.userFilterValues(req, "@a")
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) != 0 || len(emails) != 0 {
			t.Errorf("ids/emails = %v/%v", ids, emails)
		}
		if len(db.log) != 0 {
			t.Errorf("storage contacted: %v", db.log)
		}
	})

	t.Run("handle prefix is stripped before search", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{{match: "WITH scored AS", rows: [][]any{
			{testAdminID, "raw@example.com"},
		}}}}
		h := &Handler{DB: db}
		ids, emails, err := h.userFilterValues(req, "@rawx18")
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) != 1 || len(emails) != 1 {
			t.Errorf("ids/emails = %v/%v", ids, emails)
		}
	})
}

func TestEscapeLike(t *testing.T) {
	if got := escapeLike(`50%_a\b`); got != `50\%\_a\\b` {
		t.Errorf("escapeLike = %q", got)
	}
}

func TestDedupe(t *testing.T) {
	got := dedupe([]string{"a", "", "b", "a", "b", "c"})
	if strings.Join(got, ",") != "a,b,c" {
		t.Errorf("dedupe = %v", got)
	}
	if empty := dedupe(nil); empty == nil || len(empty) != 0 {
		t.Errorf("dedupe(nil) = %#v, want empty non-nil slice", empty)
	}
}

func TestChInCondition(t *testing.T) {
	params := clickhouse.Settings{}
	if got := chInCondition("actor_id", nil, "actor_id", params); got != "" {
		t.Errorf("empty values produced condition %q", got)
	}
	got := chInCondition("actor_id", []string{"a", "b"}, "actor_id", params)
	want := "actor_id IN ({actor_id_0:String}, {actor_id_1:String})"
	if got != want {
		t.Errorf("condition = %q, want %q", got, want)
	}
	if params["param_actor_id_0"] != "a" || params["param_actor_id_1"] != "b" {
		t.Errorf("params = %v", params)
	}
}

func TestIntQuery(t *testing.T) {
	parse := func(target string) (int, bool, int, string) {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", target, nil)
		n, ok := intQuery(w, r, "limit", 100)
		return n, ok, w.Code, w.Body.String()
	}
	if n, ok, _, _ := parse("/x"); n != 100 || !ok {
		t.Errorf("absent param = %d, %v", n, ok)
	}
	if n, ok, _, _ := parse("/x?limit=7"); n != 7 || !ok {
		t.Errorf("limit=7 = %d, %v", n, ok)
	}
	_, ok, code, body := parse("/x?limit=lots")
	if ok || code != 422 {
		t.Errorf("garbage int accepted (code %d)", code)
	}
	if !strings.Contains(body, `"type":"int_parsing"`) || !strings.Contains(body, `"input":"lots"`) {
		t.Errorf("validation shape = %s", body)
	}
}

func TestSecurityEventsQueryShape(t *testing.T) {
	backend := &chBackend{rows: []map[string]any{{"event_type": "auth.login"}}}
	h := &Handler{DB: &fakeDB{}, CH: newCHClient(t, backend)}

	w := httptest.NewRecorder()
	h.securityEvents(w, httptest.NewRequest("GET",
		"/api/v1/operator/security-events?event_type=auth.login&severity=warning&limit=5000&offset=-4", nil))
	if w.Code != 200 {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	sql := backend.body(0)
	if !strings.Contains(sql, "event_type = {et:String}") ||
		!strings.Contains(sql, "severity = {sev:String}") {
		t.Errorf("filters missing from SQL: %s", sql)
	}
	if !strings.Contains(sql, "LIMIT 1000 OFFSET 0") {
		t.Errorf("limit/offset not clamped: %s", sql)
	}
	qs := backend.lastQuery()
	if qs.Get("param_et") != "auth.login" || qs.Get("param_sev") != "warning" {
		t.Errorf("bound params = %v", qs)
	}
	if !strings.Contains(w.Body.String(), `"total":1`) {
		t.Errorf("body = %s", w.Body.String())
	}
}

func TestSecurityEventsActorFilter(t *testing.T) {
	t.Run("resolved user narrows by id and email", func(t *testing.T) {
		backend := &chBackend{}
		db := &fakeDB{stubs: []stub{{match: "WITH scored AS", rows: [][]any{
			{testAdminID, "admin@example.com"},
		}}}}
		h := &Handler{DB: db, CH: newCHClient(t, backend)}
		w := httptest.NewRecorder()
		h.securityEvents(w, httptest.NewRequest("GET",
			"/api/v1/operator/security-events?actor_email=admin", nil))
		if w.Code != 200 {
			t.Fatalf("code = %d: %s", w.Code, w.Body.String())
		}
		sql := backend.body(0)
		if !strings.Contains(sql, "actor_id IN ({actor_id_0:String})") ||
			!strings.Contains(sql, "actor_email IN ({actor_email_0:String})") {
			t.Errorf("actor conditions missing: %s", sql)
		}
		qs := backend.lastQuery()
		if qs.Get("param_actor_id_0") != testAdminID.String() ||
			qs.Get("param_actor_email_0") != "admin@example.com" {
			t.Errorf("bound params = %v", qs)
		}
	})

	t.Run("unresolved filter falls back to literal email match", func(t *testing.T) {
		backend := &chBackend{}
		h := &Handler{DB: &fakeDB{}, CH: newCHClient(t, backend)}
		w := httptest.NewRecorder()
		h.securityEvents(w, httptest.NewRequest("GET",
			"/api/v1/operator/security-events?actor_email=%40x", nil))
		if w.Code != 200 {
			t.Fatalf("code = %d: %s", w.Code, w.Body.String())
		}
		if !strings.Contains(backend.body(0), "actor_email = {ae:String}") {
			t.Errorf("fallback condition missing: %s", backend.body(0))
		}
		if backend.lastQuery().Get("param_ae") != "@x" {
			t.Errorf("bound params = %v", backend.lastQuery())
		}
	})
}

func TestSecurityEventsValidation(t *testing.T) {
	backend := &chBackend{}
	h := &Handler{DB: &fakeDB{}, CH: newCHClient(t, backend)}
	w := httptest.NewRecorder()
	h.securityEvents(w, httptest.NewRequest("GET",
		"/api/v1/operator/security-events?limit=lots", nil))
	if w.Code != 422 || !strings.Contains(w.Body.String(), "int_parsing") {
		t.Errorf("bad limit: %d %s", w.Code, w.Body.String())
	}
	if backend.requestCount() != 0 {
		t.Error("validation failure still contacted the event store")
	}
}

func TestSecurityEventsBackendFailure(t *testing.T) {
	backend := &chBackend{status: 500}
	h := &Handler{DB: &fakeDB{}, CH: newCHClient(t, backend)}
	w := httptest.NewRecorder()
	h.securityEvents(w, httptest.NewRequest("GET", "/api/v1/operator/security-events", nil))
	if w.Code != 500 || !strings.Contains(w.Body.String(), `"detail":"Internal error"`) {
		t.Errorf("backend failure: %d %s", w.Code, w.Body.String())
	}
}

func TestTracePrivacyRoundTrip(t *testing.T) {
	t.Run("read uses stored value", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{{match: "FROM enterprise_config WHERE key",
			argMatch: "security.trace_privacy", rows: [][]any{{"true"}}}}}
		h := &Handler{DB: db, Settings: &settings.Store{DB: db}}
		w := httptest.NewRecorder()
		h.getTracePrivacy(w, httptest.NewRequest("GET", "/api/v1/operator/trace-privacy", nil))
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"trace_privacy":true}` {
			t.Errorf("read: %d %s", w.Code, w.Body.String())
		}
	})

	t.Run("read falls back to the registry default", func(t *testing.T) {
		db := &fakeDB{}
		h := &Handler{DB: db, Settings: &settings.Store{DB: db}}
		w := httptest.NewRecorder()
		h.getTracePrivacy(w, httptest.NewRequest("GET", "/api/v1/operator/trace-privacy", nil))
		if strings.TrimSpace(w.Body.String()) != `{"trace_privacy":false}` {
			t.Errorf("default read: %s", w.Body.String())
		}
	})

	t.Run("write persists and reports the new value", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{callerStub()}}
		h := &Handler{DB: db, Settings: &settings.Store{DB: db}}
		w := httptest.NewRecorder()
		r := asAdmin(httptest.NewRequest("PUT", "/api/v1/operator/trace-privacy",
			strings.NewReader(`{"trace_privacy":true}`)))
		h.setTracePrivacy(w, r)
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"trace_privacy":true}` {
			t.Fatalf("write: %d %s", w.Code, w.Body.String())
		}
		_, args, ok := db.statement("INSERT INTO enterprise_config")
		if !ok {
			t.Fatalf("no upsert issued: %v", db.log)
		}
		if args[0] != "security.trace_privacy" || args[1] != "true" {
			t.Errorf("upsert args = %v", args)
		}
	})

	t.Run("write requires credentials", func(t *testing.T) {
		db := &fakeDB{}
		h := &Handler{DB: db}
		w := httptest.NewRecorder()
		h.setTracePrivacy(w, httptest.NewRequest("PUT", "/api/v1/operator/trace-privacy",
			strings.NewReader(`{"trace_privacy":true}`)))
		if w.Code != 401 {
			t.Errorf("anonymous write: %d", w.Code)
		}
		if db.countStatements("INSERT") != 0 {
			t.Error("anonymous write reached storage")
		}
	})
}

func TestRegisteredAgentsOnlyRoundTrip(t *testing.T) {
	t.Run("read is open and defaults to false", func(t *testing.T) {
		db := &fakeDB{}
		h := &Handler{DB: db, Settings: &settings.Store{DB: db}}
		w := httptest.NewRecorder()
		h.getRegisteredAgentsOnly(w, httptest.NewRequest("GET", "/api/v1/operator/registered-agents-only", nil))
		if strings.TrimSpace(w.Body.String()) != `{"registered_agents_only":false}` {
			t.Errorf("default read: %s", w.Body.String())
		}
	})

	t.Run("write disables with a false body", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{callerStub()}}
		h := &Handler{DB: db, Settings: &settings.Store{DB: db}}
		w := httptest.NewRecorder()
		r := asAdmin(httptest.NewRequest("PUT", "/api/v1/operator/registered-agents-only",
			strings.NewReader(`{"registered_agents_only":false}`)))
		h.setRegisteredAgentsOnly(w, r)
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"registered_agents_only":false}` {
			t.Fatalf("write: %d %s", w.Code, w.Body.String())
		}
		_, args, ok := db.statement("INSERT INTO enterprise_config")
		if !ok {
			t.Fatalf("no upsert issued: %v", db.log)
		}
		if args[0] != "registry.registered_agents_only" || args[1] != "false" {
			t.Errorf("upsert args = %v", args)
		}
	})
}

func TestSetPolicyRejectsGarbageBody(t *testing.T) {
	db := &fakeDB{stubs: []stub{callerStub()}}
	h := &Handler{DB: db}
	w := httptest.NewRecorder()
	r := asAdmin(httptest.NewRequest("PUT", "/api/v1/operator/trace-privacy",
		strings.NewReader("not-json")))
	h.setTracePrivacy(w, r)
	if w.Code != 422 {
		t.Fatalf("garbage body: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		Detail []map[string]any `json:"detail"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Detail) != 1 || resp.Detail[0]["type"] != "missing" ||
		resp.Detail[0]["msg"] != "Field required" {
		t.Errorf("validation shape = %s", w.Body.String())
	}
	if db.countStatements("INSERT") != 0 {
		t.Error("garbage body reached storage")
	}
}

func TestClearCacheWithoutRedis(t *testing.T) {
	db := &fakeDB{stubs: []stub{callerStub()}}
	h := &Handler{DB: db}
	w := httptest.NewRecorder()
	h.clearCache(w, asAdmin(httptest.NewRequest("POST", "/api/v1/operator/cache/clear", nil)))
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"cleared":0}` {
		t.Errorf("clear without redis: %d %s", w.Code, w.Body.String())
	}

	anon := httptest.NewRecorder()
	h.clearCache(anon, httptest.NewRequest("POST", "/api/v1/operator/cache/clear", nil))
	if anon.Code != 401 {
		t.Errorf("anonymous clear: %d", anon.Code)
	}
}

func TestCallerDeniesAnonymousAndUnknownUsers(t *testing.T) {
	db := &fakeDB{} // no user row: claims resolve to nobody
	h := &Handler{DB: db}

	anon := httptest.NewRecorder()
	if _, ok := h.caller(anon, httptest.NewRequest("GET", "/x", nil)); ok {
		t.Error("anonymous request produced an actor")
	}
	if anon.Code != 401 || !strings.Contains(anon.Body.String(), "Missing credentials") {
		t.Errorf("anonymous: %d %s", anon.Code, anon.Body.String())
	}

	unknown := httptest.NewRecorder()
	if _, ok := h.caller(unknown, asAdmin(httptest.NewRequest("GET", "/x", nil))); ok {
		t.Error("unknown user produced an actor")
	}
	if unknown.Code != 401 || !strings.Contains(unknown.Body.String(), "Unknown user") {
		t.Errorf("unknown user: %d %s", unknown.Code, unknown.Body.String())
	}
}
