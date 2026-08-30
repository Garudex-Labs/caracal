// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package execdash

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// aiInsightsCacheKey matches the generation endpoint's cache slot.
const aiInsightsCacheKey = "exec.ai_insights"

// RedisReader is the cache read the insight window needs.
type RedisReader interface {
	Get(ctx context.Context, key string) *redis.StringCmd
}

// RedisCache adds the write the generation endpoint needs.
type RedisCache interface {
	RedisReader
	Set(ctx context.Context, key string, value any, expiration time.Duration) *redis.StatusCmd
}

func limitParam(w http.ResponseWriter, r *http.Request, def, max int) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return def, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "int_parsing", "loc": []string{"query", "limit"},
			"msg": "Input should be a valid integer, unable to parse string as an integer", "input": raw,
		}}})
		return 0, false
	}
	if n > max {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "less_than_equal", "loc": []string{"query", "limit"},
			"msg": "Input should be less than or equal to " + strconv.Itoa(max), "input": raw,
			"ctx": map[string]any{"le": max},
		}}})
		return 0, false
	}
	if n < 1 {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "greater_than_equal", "loc": []string{"query", "limit"},
			"msg": "Input should be greater than or equal to 1", "input": raw,
			"ctx": map[string]any{"ge": 1},
		}}})
		return 0, false
	}
	return n, true
}

func (h *Handler) topAgents(w http.ResponseWriter, r *http.Request) {
	limit, ok := limitParam(w, r, 10, 50)
	if !ok {
		return
	}
	scored, err := h.Store.TopAgents(r.Context(), limit)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	type wireItem struct {
		ID             string      `json:"id"`
		Name           string      `json:"name"`
		Category       string      `json:"category"`
		CompositeScore json.Number `json:"composite_score"`
		Sessions       int64       `json:"sessions"`
		Downloads      int64       `json:"downloads"`
		WeeklyTrend    []int64     `json:"weekly_trend"`
	}
	out := make([]wireItem, 0, len(scored))
	for _, s := range scored {
		out = append(out, wireItem{
			ID: s.ID, Name: s.Name, Category: s.Category,
			CompositeScore: floatNumber(s.CompositeScore),
			Sessions:       s.Sessions, Downloads: s.Downloads, WeeklyTrend: s.WeeklyTrend,
		})
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) departments(w http.ResponseWriter, r *http.Request) {
	departments, err := h.Store.Departments(r.Context(), days(r))
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	type wireItem struct {
		Department      string      `json:"department"`
		UserCount       int64       `json:"user_count"`
		AgentCount      int64       `json:"agent_count"`
		UtilizationPct  json.Number `json:"utilization_pct"`
		SessionsPerUser json.Number `json:"sessions_per_user"`
	}
	out := make([]wireItem, 0, len(departments))
	for _, d := range departments {
		out = append(out, wireItem{
			Department: d.Department, UserCount: d.UserCount, AgentCount: d.AgentCount,
			UtilizationPct: floatNumber(d.UtilizationPct), SessionsPerUser: floatNumber(d.SessionsPerUser),
		})
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"departments": out})
}

func (h *Handler) deptTokens(w http.ResponseWriter, r *http.Request) {
	tokens, err := h.Store.DeptTokens(r.Context(), days(r))
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	type wireItem struct {
		Department      string      `json:"department"`
		TokensUsed      int64       `json:"tokens_used"`
		CostPerTask     json.Number `json:"cost_per_task"`
		SessionsPerUser json.Number `json:"sessions_per_user"`
		TrendPct        json.Number `json:"trend_pct"`
	}
	out := make([]wireItem, 0, len(tokens))
	for _, t := range tokens {
		out = append(out, wireItem{
			Department: t.Department, TokensUsed: t.TokensUsed,
			CostPerTask:     floatNumber(t.CostPerTask),
			SessionsPerUser: floatNumber(t.SessionsPerUser),
			TrendPct:        floatNumber(t.TrendPct),
		})
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) costSummary(w http.ResponseWriter, r *http.Request) {
	summary, err := h.Store.CostSummary(r.Context())
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	type monthWire struct {
		Month   string      `json:"month"`
		AISpend json.Number `json:"ai_spend"`
		Savings json.Number `json:"savings"`
	}
	trend := make([]monthWire, 0, len(summary.Months))
	for _, m := range summary.Months {
		trend = append(trend, monthWire{Month: m, AISpend: floatNumber(0), Savings: floatNumber(0)})
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"monthly_savings":          floatNumber(0),
		"cost_reduction_pct":       floatNumber(0),
		"projected_annual_savings": floatNumber(0),
		"cost_per_task":            floatNumber(0),
		"monthly_trend":            trend,
		"by_category":              []any{},
		"configured":               summary.Configured,
	})
}

func (h *Handler) roiProjections(w http.ResponseWriter, r *http.Request) {
	// Currency cost is unavailable in session telemetry; the projection set
	// stays empty until ingestion stores a real monetary value.
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"projections":              []any{},
		"growth_rate_pct":          floatNumber(0),
		"time_to_breakeven_months": nil,
		"total_invested":           floatNumber(0),
		"total_saved":              floatNumber(0),
		"roi_multiple":             floatNumber(0),
	})
}

func (h *Handler) strategicInsights(w http.ResponseWriter, r *http.Request) {
	insights, err := h.Store.StrategicInsights(r.Context())
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	models := make([]map[string]any, 0, len(insights.ModelComparison))
	for _, m := range insights.ModelComparison {
		models = append(models, map[string]any{
			"model": m.Model, "sessions": m.Sessions, "avg_cost": floatNumber(0),
			"avg_tokens": m.AvgTokens, "success_rate": floatNumber(m.SuccessRate), "best_at": m.BestAt,
		})
	}
	gaps := make([]map[string]any, 0, len(insights.DepartmentGaps))
	for _, g := range insights.DepartmentGaps {
		gaps = append(gaps, map[string]any{
			"department": g.Department, "adoption_pct": floatNumber(g.AdoptionPct),
			"sessions": g.Sessions, "opportunity": g.Opportunity,
		})
	}
	platforms := make([]map[string]any, 0, len(insights.PlatformComparison))
	for _, p := range insights.PlatformComparison {
		platforms = append(platforms, map[string]any{
			"platform": p.Platform, "avg_task_time_ms": floatNumber(p.AvgTaskTimeMs),
			"sessions": p.Sessions, "success_rate": floatNumber(p.SuccessRate),
		})
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"model_comparison":     models,
		"department_gaps":      gaps,
		"quick_wins":           []any{},
		"platform_comparison":  platforms,
		"power_user_pct":       floatNumber(20.0),
		"power_user_value_pct": floatNumber(insights.PowerUserValuePct),
		"total_active_users":   insights.TotalActiveUsers,
		"automatable_pct":      floatNumber(insights.AutomatablePct),
	})
}

func (h *Handler) developerBreakdown(w http.ResponseWriter, r *http.Request) {
	limit, ok := limitParam(w, r, 20, 100)
	if !ok {
		return
	}
	breakdown, err := h.Store.DeveloperBreakdown(r.Context(), limit)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	developers := make([]map[string]any, 0, len(breakdown.Developers))
	for _, d := range breakdown.Developers {
		developers = append(developers, map[string]any{
			"user_id": d.UserID, "name": d.Name, "department": d.Department,
			"sessions": d.Sessions, "tokens_consumed": d.Tokens,
			"cost": floatNumber(0), "percentile": d.Percentile,
		})
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"total_developers":  breakdown.TotalDevelopers,
		"active_developers": breakdown.ActiveDevelopers,
		"top_20_value_pct":  floatNumber(breakdown.Top20ValuePct),
		"developers":        developers,
	})
}

func (h *Handler) inactivityAlerts(w http.ResponseWriter, r *http.Request) {
	agents, users, err := h.Store.InactivityAlerts(r.Context())
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	agentItems := make([]map[string]any, 0, len(agents))
	for _, a := range agents {
		agentItems = append(agentItems, map[string]any{
			"id": a.ID, "name": a.Name, "category": a.Category,
			"last_session_days_ago": 14, "previous_sessions": a.PreviousSessions,
		})
	}
	userItems := make([]map[string]any, 0, len(users))
	for _, u := range users {
		userItems = append(userItems, map[string]any{
			"user_id": u.UserID, "name": u.Name, "department": u.Department,
			"last_session_days_ago": 14, "previous_sessions": u.PreviousSessions,
		})
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"inactive_agents": agentItems, "inactive_users": userItems,
	})
}

func (h *Handler) timeToValue(w http.ResponseWriter, r *http.Request) {
	agents, avg, err := h.Store.TimeToValue(r.Context())
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	items := make([]map[string]any, 0, len(agents))
	for _, a := range agents {
		var daysTo any
		if a.DaysTo100 != nil {
			daysTo = *a.DaysTo100
		}
		items = append(items, map[string]any{
			"id": a.ID, "name": a.Name, "category": a.Category,
			"created_at": a.CreatedAt, "days_to_100": daysTo,
			"current_sessions": a.CurrentSessions,
		})
	}
	var avgWire any
	if avg != nil {
		avgWire = floatNumber(*avg)
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"agents": items, "avg_days_to_100": avgWire,
	})
}

// aiInsights returns the cached generated report; generation itself stays
// with the insight engine.
func (h *Handler) aiInsights(w http.ResponseWriter, r *http.Request) {
	cached, err := h.Redis.Get(r.Context(), aiInsightsCacheKey).Result()
	if errors.Is(err, redis.Nil) {
		detail := "Generate an executive insight report to see LLM-powered strategic recommendations."
		empty := map[string]any{"title": "No cached report", "detail": detail}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"quick_wins": []any{}, "adoption_gaps": []any{},
			"platform_insight": empty, "model_insight": empty,
			"automation_opportunity": empty, "usage_pattern": empty,
			"generated": false, "generated_at": nil,
		})
		return
	}
	if err != nil {
		httpapi.WriteError(w, http.StatusServiceUnavailable, "Executive AI insights cache is unavailable")
		return
	}
	var report map[string]any
	if json.Unmarshal([]byte(cached), &report) != nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "Cached executive AI insights report is invalid")
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, report)
}
