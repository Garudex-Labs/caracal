// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package overview

import (
	"encoding/json"

	"net/http"
	"strconv"
	"time"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

var rangeDays = map[string]int{"24h": 1, "7d": 7, "30d": 30, "90d": 90}

func days(r *http.Request) int {
	if d, ok := rangeDays[r.URL.Query().Get("range")]; ok {
		return d
	}
	return 7
}

// Handler serves the overview endpoints.
type Handler struct {
	Store *Store
	Now   func() time.Time
}

// Routes mounts the group; run it behind optional authentication.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/overview/stats", h.stats)
	mux.HandleFunc("GET /api/v1/overview/top-mcps", h.topMcps)
	mux.HandleFunc("GET /api/v1/overview/top-agents", h.topAgents)
	mux.Handle("GET /api/v1/overview/trends", httpapi.RequireRole("operator", http.HandlerFunc(h.trends)))
	return mux
}

func viewerFrom(r *http.Request) *Viewer {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		return nil
	}
	return &Viewer{ID: claims.UserID, Role: claims.Role}
}

// floatNumber renders a float with an explicit fraction so integral values
// keep their trailing zero on the wire.
func floatNumber(f float64) json.Number {
	s := strconv.FormatFloat(f, 'f', -1, 64)
	if !containsDot(s) {
		s += ".0"
	}
	return json.Number(s)
}

func containsDot(s string) bool {
	for _, c := range s {
		if c == '.' || c == 'e' {
			return true
		}
	}
	return false
}

func (h *Handler) stats(w http.ResponseWriter, r *http.Request) {
	stats, err := h.Store.Stats(r.Context(), days(r), viewerFrom(r))
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, struct {
		TotalMcps              int64 `json:"total_mcps"`
		TotalAgents            int64 `json:"total_agents"`
		TotalUsers             int64 `json:"total_users"`
		TotalToolCalls         int64 `json:"total_tool_calls"`
		TotalAgentInteractions int64 `json:"total_agent_interactions"`
	}{stats.TotalMcps, stats.TotalAgents, stats.TotalUsers, stats.TotalToolCalls, stats.TotalAgentInteractions})
}

func (h *Handler) topMcps(w http.ResponseWriter, r *http.Request) {
	items, err := h.Store.TopMcps(r.Context(), viewerFrom(r))
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	type wireItem struct {
		ID    string      `json:"id"`
		Name  string      `json:"name"`
		Value json.Number `json:"value"`
	}
	out := make([]wireItem, 0, len(items))
	for _, it := range items {
		out = append(out, wireItem{ID: it.ID, Name: it.Name, Value: floatNumber(float64(it.Count))})
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) topAgents(w http.ResponseWriter, r *http.Request) {
	limit := 6
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
				"type": "int_parsing", "loc": []string{"query", "limit"},
				"msg": "Input should be a valid integer, unable to parse string as an integer", "input": raw,
			}}})
			return
		}
		if n > 50 {
			httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
				"type": "less_than_equal", "loc": []string{"query", "limit"},
				"msg": "Input should be less than or equal to 50", "input": raw,
				"ctx": map[string]any{"le": 50},
			}}})
			return
		}
		if n < 1 {
			httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
				"type": "greater_than_equal", "loc": []string{"query", "limit"},
				"msg": "Input should be greater than or equal to 1", "input": raw,
				"ctx": map[string]any{"ge": 1},
			}}})
			return
		}
		limit = n
	}
	agents, err := h.Store.TopAgents(r.Context(), limit, viewerFrom(r))
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	type wireAgent struct {
		ID                string  `json:"id"`
		Name              string  `json:"name"`
		Namespace         string  `json:"namespace"`
		Slug              string  `json:"slug"`
		QualifiedName     string  `json:"qualified_name"`
		Description       string  `json:"description"`
		Owner             string  `json:"owner"`
		CreatedByUsername *string `json:"created_by_username"`
		Version           string  `json:"version"`
		DownloadCount     int64   `json:"download_count"`
	}
	deref := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	out := make([]wireAgent, 0, len(agents))
	for _, a := range agents {
		out = append(out, wireAgent{
			ID: a.ID, Name: a.Name, Namespace: a.Namespace, Slug: a.Slug,
			QualifiedName: a.Namespace + "/" + a.Slug,
			Description:   deref(a.Description), Owner: deref(a.Owner), Version: deref(a.Version),
			DownloadCount: a.DownloadCount,
		})
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) trends(w http.ResponseWriter, r *http.Request) {
	now := time.Now
	if h.Now != nil {
		now = h.Now
	}
	points, err := h.Store.Trends(r.Context(), days(r), now())
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	type wirePoint struct {
		Date        string `json:"date"`
		Submissions int64  `json:"submissions"`
		Users       int64  `json:"users"`
	}
	out := make([]wirePoint, 0, len(points))
	for _, p := range points {
		out = append(out, wirePoint(p))
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}
