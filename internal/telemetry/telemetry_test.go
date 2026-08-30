// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

type fakeActivity struct{ tools, sessions int }

func (f fakeActivity) RecentActivity(context.Context, int) (int, int) {
	return f.tools, f.sessions
}

func do(h *Handler, role, authContext, method, target string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	if role != "" || authContext != "" {
		claims := auth.Claims{UserID: uuid.New(), Role: role, AuthContext: authContext}
		req = req.WithContext(httpapi.ContextWithClaims(req.Context(), claims))
	}
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func TestStatusReportsActivity(t *testing.T) {
	h := &Handler{Activity: fakeActivity{tools: 12, sessions: 4}}
	rec := do(h, "operator", auth.AuthContextOperator, http.MethodGet, "/api/v1/telemetry/status")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out["tool_call_events"] != float64(12) || out["agent_interaction_events"] != float64(4) || out["status"] != "ok" {
		t.Errorf("status body = %v", out)
	}
}

func TestStatusRequiresOperator(t *testing.T) {
	h := &Handler{Activity: fakeActivity{}}
	if rec := do(h, "user", auth.AuthContextOperator, http.MethodGet, "/api/v1/telemetry/status"); rec.Code != http.StatusForbidden {
		t.Errorf("user role status = %d, want 403", rec.Code)
	}
}

func TestMetricsShapes(t *testing.T) {
	h := &Handler{Activity: fakeActivity{}}
	cases := map[string][]string{
		"/api/v1/dashboard/tokens":           {"total_input", "total_output", "total_tokens", "avg_per_trace", "by_agent", "by_mcp", "over_time"},
		"/api/v1/dashboard/harness-usage":    {"harnesses"},
		"/api/v1/dashboard/sandbox-metrics":  {"total_runs", "oom_count", "oom_rate", "timeout_count", "timeout_rate", "avg_exit_code", "recent_runs", "cpu_over_time", "memory_over_time"},
		"/api/v1/dashboard/graphrag-metrics": {"total_queries", "avg_entities", "avg_relationships", "avg_relevance_score", "avg_embedding_latency_ms", "relevance_distribution", "recent_queries"},
	}
	for target, keys := range cases {
		authContext := auth.AuthContextOperator
		role := "operator"
		if target == "/api/v1/dashboard/tokens" {
			authContext = auth.AuthContextTenant
			role = "user"
		}
		rec := do(h, role, authContext, http.MethodGet, target)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d", target, rec.Code)
			continue
		}
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Errorf("%s: decode: %v", target, err)
			continue
		}
		for _, key := range keys {
			if _, ok := out[key]; !ok {
				t.Errorf("%s: missing key %q", target, key)
			}
		}
		if len(out) != len(keys) {
			t.Errorf("%s: key count = %d, want %d", target, len(out), len(keys))
		}
	}

	for _, target := range []string{"/api/v1/dashboard/latency-heatmap", "/api/v1/dashboard/unannotated-traces"} {
		rec := do(h, "operator", auth.AuthContextOperator, http.MethodGet, target)
		if body := rec.Body.String(); body != "[]\n" {
			t.Errorf("%s: body = %q, want empty list", target, body)
		}
	}
}

func TestTokensNeedsNoRoleFloor(t *testing.T) {
	h := &Handler{Activity: fakeActivity{}}
	if rec := do(h, "user", auth.AuthContextTenant, http.MethodGet, "/api/v1/dashboard/tokens"); rec.Code != http.StatusOK {
		t.Errorf("tenant user token status = %d, want 200", rec.Code)
	}
	if rec := do(h, "operator", auth.AuthContextOperator, http.MethodGet, "/api/v1/dashboard/tokens"); rec.Code != http.StatusForbidden {
		t.Errorf("operator context token status = %d, want 403", rec.Code)
	}
}
