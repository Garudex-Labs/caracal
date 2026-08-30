// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package telemetry serves the telemetry status probe and the dashboard
// metrics placeholders that reserve their wire shapes until the metrics
// sources land.
package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// ActivityCounter reports recent session activity.
type ActivityCounter interface {
	RecentActivity(ctx context.Context, minutes int) (toolCalls, sessions int)
}

// CHActivity counts recent activity from the session aggregates.
type CHActivity struct {
	Client *clickhouse.Client
}

// RecentActivity returns tool-call and session counts for the window;
// a failing store reads as zero activity rather than an error.
func (a CHActivity) RecentActivity(ctx context.Context, minutes int) (int, int) {
	rows, err := a.Client.QueryJSON(ctx,
		"SELECT sum(tool_call_count) AS tools, count() AS sessions "+
			"FROM session_stats_agg FINAL "+
			"WHERE last_event_time > now() - INTERVAL {minutes:UInt32} MINUTE "+
			"FORMAT JSON",
		clickhouse.Settings{"param_minutes": strconv.Itoa(minutes)})
	if err != nil || len(rows) == 0 {
		return 0, 0
	}
	return intValue(rows[0]["tools"]), intValue(rows[0]["sessions"])
}

// Handler serves the telemetry and dashboard-metrics route groups.
type Handler struct {
	Activity ActivityCounter
}

// Routes returns the route group. Callers mount it behind authentication;
// role floors are enforced per route.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	operator := func(fn http.HandlerFunc) http.Handler {
		return httpapi.RequireAuthContext(auth.AuthContextOperator, httpapi.RequireRole("operator", fn))
	}
	tenant := func(fn http.HandlerFunc) http.Handler {
		return httpapi.RequireAuthContext(auth.AuthContextTenant, fn)
	}

	mux.Handle("GET /api/v1/telemetry/status", operator(h.status))
	mux.Handle("GET /api/v1/dashboard/tokens", tenant(h.tokens))
	mux.Handle("GET /api/v1/dashboard/harness-usage", operator(h.harnessUsage))
	mux.Handle("GET /api/v1/dashboard/sandbox-metrics", operator(h.sandboxMetrics))
	mux.Handle("GET /api/v1/dashboard/graphrag-metrics", operator(h.graphragMetrics))
	mux.Handle("GET /api/v1/dashboard/latency-heatmap", operator(h.latencyHeatmap))
	mux.Handle("GET /api/v1/dashboard/unannotated-traces", operator(h.unannotatedTraces))
	return mux
}

func (h *Handler) status(w http.ResponseWriter, r *http.Request) {
	toolCalls, sessions := h.Activity.RecentActivity(r.Context(), 60)
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"tool_call_events":         toolCalls,
		"agent_interaction_events": sessions,
		"status":                   "ok",
	})
}

func (h *Handler) tokens(w http.ResponseWriter, _ *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"total_input": 0, "total_output": 0, "total_tokens": 0,
		"avg_per_trace": json.Number("0.0"), "by_agent": []any{}, "by_mcp": []any{}, "over_time": []any{},
	})
}

func (h *Handler) harnessUsage(w http.ResponseWriter, _ *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"harnesses": []any{}})
}

func (h *Handler) sandboxMetrics(w http.ResponseWriter, _ *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"total_runs": 0, "oom_count": 0, "oom_rate": json.Number("0.0"),
		"timeout_count": 0, "timeout_rate": json.Number("0.0"), "avg_exit_code": nil,
		"recent_runs": []any{}, "cpu_over_time": []any{}, "memory_over_time": []any{},
	})
}

func (h *Handler) graphragMetrics(w http.ResponseWriter, _ *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"total_queries": 0, "avg_entities": nil, "avg_relationships": nil,
		"avg_relevance_score": nil, "avg_embedding_latency_ms": nil,
		"relevance_distribution": []any{}, "recent_queries": []any{},
	})
}

func (h *Handler) latencyHeatmap(w http.ResponseWriter, _ *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, []any{})
}

func (h *Handler) unannotatedTraces(w http.ResponseWriter, _ *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, []any{})
}

// intValue coerces a ClickHouse JSON number, which arrives as a float for
// 32-bit types, a quoted string for 64-bit types, and null for empty sums.
func intValue(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case string:
		n, err := strconv.Atoi(v)
		if err != nil {
			return 0
		}
		return n
	default:
		return 0
	}
}
