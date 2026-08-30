// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"net/http"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// defaultProjectID scopes single-tenant telemetry.
const defaultProjectID = "default"

// dangerPurge deletes all deployment telemetry and insight artifacts.
func (h *Handler) dangerPurge(w http.ResponseWriter, r *http.Request) {
	a, ok := h.caller(w, r)
	if !ok {
		return
	}
	tables := []string{"session_events", "session_stats_agg"}
	for _, table := range tables {
		// Best-effort per table, like the incumbent: one failing mutation
		// must not abort the relational cleanup.
		_ = h.CH.Exec(r.Context(),
			"ALTER TABLE "+table+" DELETE WHERE project_id = {project_id:String}",
			clickhouse.Settings{"param_project_id": defaultProjectID})
	}
	counts := map[string]int64{}
	for column, table := range map[string]string{
		"deleted_reports":      "insight_reports",
		"deleted_facets":       "insight_session_facets",
		"deleted_session_meta": "insight_session_meta",
		"deleted_meta_cache":   "insight_meta_cache",
	} {
		tag, err := h.DB.Exec(r.Context(),
			"DELETE FROM "+table+" WHERE agent_id IN (SELECT id FROM agents)")
		if err != nil {
			internalErr(w)
			return
		}
		counts[column] = tag.RowsAffected()
	}
	h.emitEvent(r.Context(), a, "admin.setting.changed", "critical",
		"danger.purge_traces_insights", "danger_zone",
		"Purged deployment telemetry traces/session data and insight reports")
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"project_id":           defaultProjectID,
		"clickhouse_tables":    tables,
		"deleted_reports":      counts["deleted_reports"],
		"deleted_facets":       counts["deleted_facets"],
		"deleted_session_meta": counts["deleted_session_meta"],
		"deleted_meta_cache":   counts["deleted_meta_cache"],
	})
}
