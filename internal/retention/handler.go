// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package retention

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// Handler serves the retention administration group.
type Handler struct {
	Store *Store
}

// Routes mounts the group; run it behind required operator authentication.
// The write and preview paths enforce the operator floor.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/operator/retention", h.getConfig)
	mux.Handle("PUT /api/v1/operator/retention", httpapi.RequireRole("operator", http.HandlerFunc(h.putConfig)))
	mux.Handle("GET /api/v1/operator/retention/preview", httpapi.RequireRole("operator", http.HandlerFunc(h.preview)))
	mux.HandleFunc("GET /api/v1/operator/retention/stats", h.stats)
	mux.HandleFunc("GET /api/v1/operator/retention/warnings", h.warnings)
	return mux
}

type configWire struct {
	RetentionEnabled    bool `json:"retention_enabled"`
	DataRetentionDays   any  `json:"data_retention_days"`
	ScoreRetentionDays  any  `json:"score_retention_days"`
	MaxTraceCount       any  `json:"max_trace_count"`
	GlobalRetentionDays int  `json:"global_retention_days"`
}

func configToWire(c Config) configWire {
	return configWire{
		RetentionEnabled:    c.Enabled,
		DataRetentionDays:   nilIfZero(c.DataRetentionDays),
		ScoreRetentionDays:  nilIfZero(c.ScoreRetentionDays),
		MaxTraceCount:       nilIfZero(c.MaxTraceCount),
		GlobalRetentionDays: c.GlobalRetentionDays,
	}
}

func (h *Handler) getConfig(w http.ResponseWriter, r *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, configToWire(h.Store.ReadConfig(r.Context())))
}

func (h *Handler) putConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RetentionEnabled   bool `json:"retention_enabled"`
		DataRetentionDays  *int `json:"data_retention_days"`
		ScoreRetentionDays *int `json:"score_retention_days"`
		MaxTraceCount      *int `json:"max_trace_count"`
	}
	raw, rerr := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var rawInput map[string]any
	if rerr != nil || json.Unmarshal(raw, &rawInput) != nil || json.Unmarshal(raw, &body) != nil {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "json_invalid", "loc": []string{"body"}, "msg": "Invalid JSON: expected value", "input": nil,
		}}})
		return
	}
	update := Update{
		Enabled:            body.RetentionEnabled,
		DataRetentionDays:  body.DataRetentionDays,
		ScoreRetentionDays: body.ScoreRetentionDays,
		MaxTraceCount:      body.MaxTraceCount,
	}
	if err := update.Validate(); err != nil {
		// The validation layer wraps model rules as value errors; the
		// error context serializes to an empty object on the wire.
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "value_error", "loc": []string{"body"},
			"msg":   "Value error, " + err.Error(),
			"input": rawInput,
			"ctx":   map[string]any{"error": map[string]any{}},
		}}})
		return
	}
	config := h.Store.ReadConfig(r.Context())
	if body.DataRetentionDays != nil && config.GlobalRetentionDays > 0 &&
		*body.DataRetentionDays > config.GlobalRetentionDays {
		httpapi.WriteError(w, http.StatusUnprocessableEntity,
			fmt.Sprintf("data_retention_days cannot exceed global ceiling of %d days", config.GlobalRetentionDays))
		return
	}
	if err := h.Store.WriteConfig(r.Context(), update); err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	claims, _ := httpapi.ClaimsFrom(r.Context())
	var email, role string
	_ = h.Store.DB.QueryRow(r.Context(), `SELECT email, role FROM users WHERE id = $1`, claims.UserID).Scan(&email, &role)
	state := "disabled"
	if body.RetentionEnabled {
		state = "enabled"
	}
	h.Store.EmitSettingEvent(r.Context(), claims.UserID.String(), email, role,
		fmt.Sprintf("Data retention %s (days=%s, scores=%s, max=%s)",
			state, intOrNone(body.DataRetentionDays), intOrNone(body.ScoreRetentionDays), intOrNone(body.MaxTraceCount)))
	httpapi.WriteJSON(w, http.StatusOK, configToWire(h.Store.ReadConfig(r.Context())))
}

// intOrNone renders optional integers the way the settings trail records them.
func intOrNone(v *int) string {
	if v == nil {
		return "None"
	}
	return strconv.Itoa(*v)
}

func (h *Handler) preview(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("days")
	if raw == "" {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "missing", "loc": []string{"query", "days"}, "msg": "Field required", "input": nil,
		}}})
		return
	}
	days, err := strconv.Atoi(raw)
	if err != nil {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
			"type": "int_parsing", "loc": []string{"query", "days"},
			"msg": "Input should be a valid integer, unable to parse string as an integer", "input": raw,
		}}})
		return
	}
	if days < 7 {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "days must be >= 7")
		return
	}
	preview, err := h.Store.Preview(r.Context(), days)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, preview)
}

func (h *Handler) stats(w http.ResponseWriter, r *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, h.Store.Stats(r.Context()))
}

func (h *Handler) warnings(w http.ResponseWriter, r *http.Request) {
	warnings, err := h.Store.Warnings(r.Context())
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, warnings)
}
