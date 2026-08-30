// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/settings"
)

func TestRestartStatusShapes(t *testing.T) {
	get := func(db *fakeDB) map[string]any {
		t.Helper()
		h := &Handler{DB: db}
		w := httptest.NewRecorder()
		h.restartStatus(w, httptest.NewRequest("GET", "/api/v1/operator/restart/status", nil))
		if w.Code != 200 {
			t.Fatalf("code = %d: %s", w.Code, w.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	t.Run("no pending flag", func(t *testing.T) {
		out := get(&fakeDB{})
		if out["required"] != false || out["changed_at"] != nil {
			t.Errorf("out = %v", out)
		}
		if keys, ok := out["keys"].([]any); !ok || len(keys) != 0 {
			t.Errorf("keys = %v", out["keys"])
		}
	})

	t.Run("pending with state", func(t *testing.T) {
		out := get(&fakeDB{stubs: []stub{{
			match: "FROM enterprise_config WHERE key",
			rows:  [][]any{{`{"changed_at":"2026-08-30T08:00:00Z","keys":["observability.log_level"]}`}},
		}}})
		if out["required"] != true || out["changed_at"] != "2026-08-30T08:00:00Z" {
			t.Errorf("out = %v", out)
		}
		keys, ok := out["keys"].([]any)
		if !ok || len(keys) != 1 || keys[0] != "observability.log_level" {
			t.Errorf("keys = %v", out["keys"])
		}
	})

	t.Run("pending with corrupt state", func(t *testing.T) {
		out := get(&fakeDB{stubs: []stub{{
			match: "FROM enterprise_config WHERE key",
			rows:  [][]any{{"not json"}},
		}}})
		if out["required"] != true || out["changed_at"] != nil {
			t.Errorf("out = %v", out)
		}
		if keys, ok := out["keys"].([]any); !ok || len(keys) != 0 {
			t.Errorf("keys = %v", out["keys"])
		}
	})
}

func TestDangerPurge(t *testing.T) {
	t.Run("purges and reports counts", func(t *testing.T) {
		backend := &chBackend{}
		db := &fakeDB{
			stubs: []stub{callerStub()},
			execs: []execStub{
				{match: "DELETE FROM insight_reports", affected: 3},
				{match: "DELETE FROM insight_session_facets", affected: 2},
				{match: "DELETE FROM insight_session_meta", affected: 5},
				{match: "DELETE FROM insight_meta_cache", affected: 1},
			},
		}
		h := &Handler{DB: db, CH: newCHClient(t, backend)}
		w := httptest.NewRecorder()
		h.dangerPurge(w, asAdmin(httptest.NewRequest("POST",
			"/api/v1/operator/settings/danger/purge-traces-insights", nil)))
		if w.Code != 200 {
			t.Fatalf("code = %d: %s", w.Code, w.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if out["project_id"] != "default" {
			t.Errorf("project_id = %v", out["project_id"])
		}
		wantCounts := map[string]float64{
			"deleted_reports": 3, "deleted_facets": 2,
			"deleted_session_meta": 5, "deleted_meta_cache": 1,
		}
		for key, want := range wantCounts {
			if out[key] != want {
				t.Errorf("%s = %v, want %v", key, out[key], want)
			}
		}
		// Two mutation statements plus the audit event reach the event store.
		if backend.requestCount() != 3 {
			t.Errorf("event-store requests = %d", backend.requestCount())
		}
		if !strings.Contains(backend.body(0), "ALTER TABLE session_events DELETE") {
			t.Errorf("first mutation = %s", backend.body(0))
		}
		if !strings.Contains(backend.body(2), "danger.purge_traces_insights") {
			t.Errorf("audit event = %s", backend.body(2))
		}
	})

	t.Run("relational failure answers 500", func(t *testing.T) {
		backend := &chBackend{}
		db := &fakeDB{
			stubs: []stub{callerStub()},
			execs: []execStub{
				{match: "DELETE FROM insight_reports", err: errors.New("db down")},
				{match: "DELETE FROM insight_session_facets", err: errors.New("db down")},
				{match: "DELETE FROM insight_session_meta", err: errors.New("db down")},
				{match: "DELETE FROM insight_meta_cache", err: errors.New("db down")},
			},
		}
		h := &Handler{DB: db, CH: newCHClient(t, backend)}
		w := httptest.NewRecorder()
		h.dangerPurge(w, asAdmin(httptest.NewRequest("POST",
			"/api/v1/operator/settings/danger/purge-traces-insights", nil)))
		if w.Code != 500 || !strings.Contains(w.Body.String(), "Internal error") {
			t.Errorf("code = %d: %s", w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "db down") {
			t.Errorf("driver detail leaked: %s", w.Body.String())
		}
	})
}

func TestApplyResources(t *testing.T) {
	backend := &chBackend{}
	db := &fakeDB{stubs: []stub{
		callerStub(),
		{match: "LIKE 'resource.%'", rows: [][]any{
			{"resource.max_query_memory_mb", "256"},
			{"resource.join_memory_mb", "64"},
			{"resource.unknown_knob", "9"},
		}},
	}}
	h := &Handler{DB: db, CH: newCHClient(t, backend)}
	w := httptest.NewRecorder()
	h.applyResources(w, asAdmin(httptest.NewRequest("POST", "/api/v1/operator/resources/apply", nil)))
	if w.Code != 200 {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	// Only whitelisted keys apply, preserving row order in the object.
	wantApplied := `"applied":{"resource.max_query_memory_mb":"256","resource.join_memory_mb":"64"}`
	if !strings.Contains(w.Body.String(), wantApplied) {
		t.Errorf("body = %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "ClickHouse resource settings applied") {
		t.Errorf("message missing: %s", w.Body.String())
	}
	if backend.requestCount() != 1 ||
		!strings.Contains(backend.body(0), "resource.max_query_memory_mb") {
		t.Errorf("audit event = %d requests", backend.requestCount())
	}
}

func TestConnectionErrorHint(t *testing.T) {
	cases := []struct {
		name, errStr, model, want string
	}{
		{"bedrock bad model", "model identifier is invalid", "bedrock/us.anthropic.claude",
			"Model ID is not available in your region"},
		{"generic bad model", "model_not_found", "openai/gpt-x",
			"Model ID not recognized. Verify the format: provider/model-name"},
		{"anthropic auth", "401 unauthorized", "anthropic/claude", "console.anthropic.com"},
		{"openai auth", "invalid api key", "openai/gpt-4o", "platform.openai.com/api-keys"},
		{"gemini auth", "forbidden", "gemini/flash", "aistudio.google.com/apikey"},
		{"unknown provider auth", "401", "mystery/model", "Authentication failed. Verify your API key."},
		{"unreachable", "connection timed out", "openai/gpt-4o",
			"Could not reach endpoint. Check your Base URL and network connectivity."},
		{"rate limited", "429 too many requests", "openai/gpt-4o",
			"Rate limited by provider. The key is valid, try again in a moment."},
		{"bedrock access", "access denied for model", "bedrock/us.anthropic.claude",
			"Model access not enabled"},
		{"fallback", "something odd", "openai/gpt-4o",
			"Connection test failed. Check your settings and try again."},
	}
	for _, tc := range cases {
		if got := connectionErrorHint(tc.errStr, tc.model); !strings.Contains(got, tc.want) {
			t.Errorf("%s: hint = %q, want substring %q", tc.name, got, tc.want)
		}
	}
}

func TestInsightsConnection(t *testing.T) {
	post := func(h *Handler, body string) map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		h.testInsightsConnection(w, httptest.NewRequest("POST",
			"/api/v1/operator/ai-engine/test-connection", strings.NewReader(body)))
		if w.Code != 200 {
			t.Fatalf("code = %d: %s", w.Code, w.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	t.Run("no model configured", func(t *testing.T) {
		h := &Handler{Settings: &settings.Store{DB: &fakeDB{}}}
		out := post(h, `{}`)
		if out["success"] != false || out["error"] != "No model configured" {
			t.Errorf("out = %v", out)
		}
		if hint, _ := out["hint"].(string); !strings.Contains(hint, "Set the Sections Model first") {
			t.Errorf("hint = %v", out["hint"])
		}
	})

	t.Run("provider auth failure maps to a hint", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "invalid api key", http.StatusUnauthorized)
		}))
		defer srv.Close()
		db := &fakeDB{stubs: []stub{
			{match: "FROM enterprise_config WHERE key", argMatch: "insights.api_base",
				rows: [][]any{{srv.URL}}},
		}}
		h := &Handler{Settings: &settings.Store{DB: db}}
		out := post(h, `{"model":"openai/test-model"}`)
		if out["success"] != false || out["model"] != "openai/test-model" || out["latency_ms"] != nil {
			t.Errorf("out = %v", out)
		}
		if errStr, _ := out["error"].(string); !strings.Contains(errStr, "401") {
			t.Errorf("error = %v", out["error"])
		}
		if hint, _ := out["hint"].(string); !strings.Contains(hint, "platform.openai.com/api-keys") {
			t.Errorf("hint = %v", out["hint"])
		}
	})

	t.Run("success reports latency", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{}`))
		}))
		defer srv.Close()
		db := &fakeDB{stubs: []stub{
			{match: "FROM enterprise_config WHERE key", argMatch: "insights.api_base",
				rows: [][]any{{srv.URL}}},
		}}
		h := &Handler{Settings: &settings.Store{DB: db}}
		out := post(h, `{"model":"openai/test-model"}`)
		if out["success"] != true || out["error"] != nil || out["hint"] != nil {
			t.Errorf("out = %v", out)
		}
		if latency, ok := out["latency_ms"].(float64); !ok || latency < 0 {
			t.Errorf("latency_ms = %v", out["latency_ms"])
		}
	})
}
