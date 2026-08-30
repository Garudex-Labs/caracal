// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package execdash

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// Handler serves the executive dashboard group.
type Handler struct {
	Store *Store
	Redis RedisCache
	// Strategic generates the AI insight report.
	Strategic StrategicGenerator
	// Settings resolves the configured generation model.
	Settings SettingsReader
}

// Routes mounts the group; run the result behind required admin
// authentication.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/exec/config", h.getConfig)
	mux.HandleFunc("PUT /api/v1/exec/config", h.putConfig)
	mux.HandleFunc("GET /api/v1/exec/adoption", h.adoption)
	mux.HandleFunc("GET /api/v1/exec/agent-counts", h.agentCounts)
	mux.HandleFunc("GET /api/v1/exec/usage-by-category", h.usageByCategory)
	mux.HandleFunc("GET /api/v1/exec/platform-coverage", h.platformCoverage)
	mux.HandleFunc("GET /api/v1/exec/platforms", h.platforms)
	mux.HandleFunc("GET /api/v1/exec/velocity", h.velocity)
	mux.HandleFunc("GET /api/v1/exec/top-agents", h.topAgents)
	mux.HandleFunc("GET /api/v1/exec/departments", h.departments)
	mux.HandleFunc("GET /api/v1/exec/dept-tokens", h.deptTokens)
	mux.HandleFunc("GET /api/v1/exec/cost-summary", h.costSummary)
	mux.HandleFunc("GET /api/v1/exec/roi-projections", h.roiProjections)
	mux.HandleFunc("GET /api/v1/exec/strategic-insights", h.strategicInsights)
	mux.HandleFunc("GET /api/v1/exec/developer-breakdown", h.developerBreakdown)
	mux.HandleFunc("GET /api/v1/exec/inactivity-alerts", h.inactivityAlerts)
	mux.HandleFunc("GET /api/v1/exec/time-to-value", h.timeToValue)
	mux.HandleFunc("GET /api/v1/exec/ai-insights", h.aiInsights)
	mux.HandleFunc("POST /api/v1/exec/ai-insights", h.generateAIInsights)
	return mux
}

var rangeDays = map[string]int{"24h": 1, "7d": 7, "30d": 30, "90d": 90}

func days(r *http.Request) int {
	if d, ok := rangeDays[r.URL.Query().Get("range")]; ok {
		return d
	}
	return 7
}

func (h *Handler) usageByCategory(w http.ResponseWriter, r *http.Request) {
	usage, err := h.Store.UsageByCategory(r.Context(), days(r))
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	type wireItem struct {
		Category  string      `json:"category"`
		Sessions  int64       `json:"sessions"`
		GrowthPct json.Number `json:"growth_pct"`
	}
	out := make([]wireItem, 0, len(usage))
	for _, u := range usage {
		out = append(out, wireItem{u.Category, u.Sessions, floatNumber(u.GrowthPct)})
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) platformCoverage(w http.ResponseWriter, r *http.Request) {
	coverage := h.Store.PlatformCoverage(r.Context())
	type wireItem struct {
		Platform string `json:"platform"`
		Users    int64  `json:"users"`
		Sessions int64  `json:"sessions"`
	}
	out := make([]wireItem, 0, len(coverage))
	for _, c := range coverage {
		out = append(out, wireItem(c))
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) platforms(w http.ResponseWriter, r *http.Request) {
	scores := h.Store.Platforms(r.Context())
	type wireItem struct {
		Platform       string      `json:"platform"`
		CompositeScore json.Number `json:"composite_score"`
		Sessions       int64       `json:"sessions"`
		AvgCost        json.Number `json:"avg_cost"`
		AvgLatencyMs   json.Number `json:"avg_latency_ms"`
		SuccessRate    *float64    `json:"success_rate"`
		ErrorRate      *float64    `json:"error_rate"`
		Users          int64       `json:"users"`
	}
	out := make([]wireItem, 0, len(scores))
	for _, s := range scores {
		out = append(out, wireItem{
			Platform:       s.Platform,
			CompositeScore: floatNumber(s.CompositeScore),
			Sessions:       s.Sessions,
			AvgCost:        floatNumber(0),
			AvgLatencyMs:   floatNumber(s.AvgLatencyMs),
			Users:          s.Users,
		})
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) velocity(w http.ResponseWriter, r *http.Request) {
	velocity := h.Store.Velocity(r.Context())
	type pointWire struct {
		Week   string `json:"week"`
		Traces int64  `json:"traces"`
	}
	points := make([]pointWire, 0, len(velocity.Weekly))
	for _, p := range velocity.Weekly {
		points = append(points, pointWire(p))
	}
	httpapi.WriteJSON(w, http.StatusOK, struct {
		Weekly            []pointWire `json:"weekly"`
		CurrentWeeklyAvg  json.Number `json:"current_weekly_avg"`
		BaselineWeeklyAvg json.Number `json:"baseline_weekly_avg"`
		Multiplier        json.Number `json:"multiplier"`
	}{points, floatNumber(velocity.CurrentWeeklyAvg), floatNumber(velocity.BaselineWeeklyAvg), floatNumber(velocity.Multiplier)})
}

// floatNumber keeps integral floats with an explicit fraction on the wire.
func floatNumber(f float64) json.Number {
	s := strconv.FormatFloat(f, 'f', -1, 64)
	dotted := false
	for _, c := range s {
		if c == '.' || c == 'e' {
			dotted = true
			break
		}
	}
	if !dotted {
		s += ".0"
	}
	return json.Number(s)
}

type configWire struct {
	ID                 string         `json:"id"`
	HourlyDevCost      json.Number    `json:"hourly_dev_cost"`
	PreAIBaselines     map[string]any `json:"pre_ai_baselines"`
	DepartmentBudgets  map[string]any `json:"department_budgets"`
	TargetAdoptionPct  int64          `json:"target_adoption_pct"`
	TargetAdoptionDate *string        `json:"target_adoption_date"`
}

func configToWire(c *Config) configWire {
	baselines := c.PreAIBaselines
	if baselines == nil {
		baselines = map[string]any{}
	}
	budgets := c.DepartmentBudgets
	if budgets == nil {
		budgets = map[string]any{}
	}
	return configWire{
		ID:                 c.ID.String(),
		HourlyDevCost:      floatNumber(c.HourlyDevCost),
		PreAIBaselines:     baselines,
		DepartmentBudgets:  budgets,
		TargetAdoptionPct:  c.TargetAdoptionPct,
		TargetAdoptionDate: c.TargetAdoptionDate,
	}
}

func (h *Handler) getConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.Store.GetConfig(r.Context())
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if cfg == nil {
		httpapi.WriteJSON(w, http.StatusOK, nil)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, configToWire(cfg))
}

func (h *Handler) putConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		HourlyDevCost      *float64       `json:"hourly_dev_cost"`
		PreAIBaselines     map[string]any `json:"pre_ai_baselines"`
		DepartmentBudgets  map[string]any `json:"department_budgets"`
		TargetAdoptionPct  *int64         `json:"target_adoption_pct"`
		TargetAdoptionDate *string        `json:"target_adoption_date"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "json_invalid", "loc": []string{"body"},
			"msg": "Invalid JSON: expected value", "input": nil,
		}}})
		return
	}
	cfg, err := h.Store.UpdateConfig(r.Context(), ConfigUpdate{
		HourlyDevCost:      body.HourlyDevCost,
		PreAIBaselines:     body.PreAIBaselines,
		DepartmentBudgets:  body.DepartmentBudgets,
		TargetAdoptionPct:  body.TargetAdoptionPct,
		TargetAdoptionDate: body.TargetAdoptionDate,
	})
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if cfg == nil {
		// The singleton row vanished between the write and the re-read.
		httpapi.WriteError(w, http.StatusInternalServerError, "Dashboard configuration is unavailable")
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, configToWire(cfg))
}

func (h *Handler) adoption(w http.ResponseWriter, r *http.Request) {
	adoption, err := h.Store.Adoption(r.Context())
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	type pointWire struct {
		Month string      `json:"month"`
		Pct   json.Number `json:"adoption_pct"`
	}
	points := make([]pointWire, 0, len(adoption.Monthly))
	for _, p := range adoption.Monthly {
		points = append(points, pointWire{Month: p.Month, Pct: floatNumber(p.Pct)})
	}
	httpapi.WriteJSON(w, http.StatusOK, struct {
		Monthly            []pointWire `json:"monthly"`
		CurrentPct         json.Number `json:"current_pct"`
		TotalUsers         int64       `json:"total_users"`
		ActiveUsers        int64       `json:"active_users"`
		DepartmentsCovered int64       `json:"departments_covered"`
	}{points, floatNumber(adoption.CurrentPct), adoption.TotalUsers, adoption.ActiveUsers, adoption.DepartmentsCovered})
}

func (h *Handler) agentCounts(w http.ResponseWriter, r *http.Request) {
	counts, err := h.Store.AgentCounts(r.Context())
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, struct {
		Total         int64            `json:"total"`
		Active        int64            `json:"active"`
		Published     int64            `json:"published"`
		InDevelopment int64            `json:"in_development"`
		ByCategory    []map[string]any `json:"by_category"`
	}{counts.Total, counts.Active, counts.Published, counts.InDevelopment, counts.ByCategory})
}
