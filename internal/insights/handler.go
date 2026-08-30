// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insights

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/internal/agents"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/insightsgen"
	"github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// Handler serves the insight report group: reads, deletions, generation,
// export, and suggestion application.
type Handler struct {
	Store  *Store
	Agents *agents.Store
	// Engine answers the availability probe.
	Engine *insightsgen.Engine
	// Gen wakes the background generation runner after a report is queued.
	Gen *insightsgen.Service
	// GenStore applies report suggestions to agent drafts.
	GenStore *insightsgen.Store
	// Config resolves runtime feature toggles.
	Config *insightsgen.Config
}

// Routes mounts the group behind the authenticated-user floor; report
// mutations are governed by agent ownership, not deployment role.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/insights/status", h.status)
	mux.HandleFunc("GET /api/v1/insights/agents/{agent_id}/session-count", h.sessionCount)
	mux.HandleFunc("GET /api/v1/insights/agents/{agent_id}/reports", h.listReports)
	mux.HandleFunc("POST /api/v1/insights/agents/{agent_id}/generate", h.generate)
	mux.HandleFunc("GET /api/v1/insights/reports/{report_id}", h.getReport)
	mux.HandleFunc("GET /api/v1/insights/reports/{report_id}/export/html", h.exportHTML)
	mux.HandleFunc("POST /api/v1/insights/reports/{report_id}/apply", h.applyReport)
	mux.HandleFunc("DELETE /api/v1/insights/agents/{agent_id}/reports", h.clearAgentReports)
	mux.HandleFunc("DELETE /api/v1/insights/reports/{report_id}", h.deleteReport)
	return mux
}

// AgentRoutes serves the agent-scoped report reads, generation, export,
// application, and deletion.
func (h *Handler) AgentRoutes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/agents/{agent_id}/insights/session-count", h.sessionCount)
	mux.HandleFunc("GET /api/v1/agents/{agent_id}/insights/reports", h.listReports)
	mux.HandleFunc("POST /api/v1/agents/{agent_id}/insights/reports", h.generate)
	mux.HandleFunc("GET /api/v1/agents/{agent_id}/insights/reports/{report_id}", h.getAgentReport)
	mux.HandleFunc("GET /api/v1/agents/{agent_id}/insights/reports/{report_id}/export/html", h.exportAgentHTML)
	mux.HandleFunc("POST /api/v1/agents/{agent_id}/insights/reports/{report_id}/apply", h.applyAgentReport)
	mux.HandleFunc("DELETE /api/v1/agents/{agent_id}/insights/reports", h.clearAgentReports)
	return mux
}

// AgentPatterns are the mux patterns AgentRoutes answers; they win over
// the broader agents-prefix registrations by specificity.
func AgentPatterns() []string {
	return []string{
		"GET /api/v1/agents/{agent_id}/insights/session-count",
		"GET /api/v1/agents/{agent_id}/insights/reports",
		"POST /api/v1/agents/{agent_id}/insights/reports",
		"GET /api/v1/agents/{agent_id}/insights/reports/{report_id}",
		"GET /api/v1/agents/{agent_id}/insights/reports/{report_id}/export/html",
		"POST /api/v1/agents/{agent_id}/insights/reports/{report_id}/apply",
		"DELETE /api/v1/agents/{agent_id}/insights/reports",
	}
}

func viewerFrom(r *http.Request) *registry.Viewer {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		return nil
	}
	projectID, _ := tenancy.ProjectIDFromContext(r.Context())
	return &registry.Viewer{ID: claims.UserID, Role: claims.Role, ProjectID: projectID}
}

// rowPermission mirrors the agent permission contract: creators and
// co-authors own; everyone else views. Deployment operators hold no
// implicit authority over tenant agents.
func rowPermission(row map[string]any, viewer *registry.Viewer) string {
	if viewer == nil {
		return "view"
	}
	if s, ok := row["created_by"].(string); ok && s == viewer.ID.String() {
		return "owner"
	}
	if coAuthors, ok := row["co_authors"].([]any); ok {
		for _, id := range coAuthors {
			if s, ok := id.(string); ok && s == viewer.ID.String() {
				return "owner"
			}
		}
	}
	return "view"
}

// resolveAgent loads the agent regardless of version status and applies
// the edit gate: insight data is the agent's private telemetry.
func (h *Handler) resolveAgent(w http.ResponseWriter, r *http.Request, viewer *registry.Viewer, identifier string, includeDeleted bool) (map[string]any, bool) {
	row, err := h.Agents.LoadWith(r.Context(), identifier, viewer,
		agents.LoadOpts{AllStatuses: true, PreferOwner: true, IncludeDeleted: includeDeleted})
	var ambiguous *agents.ErrAmbiguous
	if errors.As(err, &ambiguous) {
		httpapi.WriteError(w, http.StatusConflict, ambiguous.Error())
		return nil, false
	}
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return nil, false
	}
	if row == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Agent not found")
		return nil, false
	}
	if rowPermission(row, viewer) != "owner" {
		httpapi.WriteError(w, http.StatusForbidden, "Insufficient permissions for this agent")
		return nil, false
	}
	return row, true
}

// authorizeReport resolves the agent behind a report; invisible agents
// surface as a missing report rather than skipping the checks.
func (h *Handler) authorizeReport(w http.ResponseWriter, r *http.Request, viewer *registry.Viewer, agentID string) bool {
	row, err := h.Agents.LoadWith(r.Context(), agentID, viewer,
		agents.LoadOpts{AllStatuses: true, PreferOwner: true, IncludeDeleted: true})
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return false
	}
	if row == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Report not found")
		return false
	}
	if rowPermission(row, viewer) != "owner" {
		httpapi.WriteError(w, http.StatusForbidden, "Insufficient permissions for this agent")
		return false
	}
	return true
}

func rowText(row map[string]any, key string) string {
	if s, ok := row[key].(string); ok {
		return s
	}
	return ""
}

func (h *Handler) sessionCount(w http.ResponseWriter, r *http.Request) {
	viewer := viewerFrom(r)
	row, ok := h.resolveAgent(w, r, viewer, r.PathValue("agent_id"), false)
	if !ok {
		return
	}
	requested := r.URL.Query().Get("agent_version")
	versionID, version, err := h.Store.ApprovedVersion(r.Context(), rowText(row, "id"), requested)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if versionID == "" {
		detail := "No approved agent version found"
		if requested != "" {
			detail = fmt.Sprintf("Approved version '%s' not found", requested)
		}
		httpapi.WriteError(w, http.StatusNotFound, detail)
		return
	}
	now := time.Now().UTC()
	count := h.Store.SessionCount(r.Context(), rowText(row, "id"), rowText(row, "name"),
		now.AddDate(0, 0, -14), now, version)
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"session_count":    count,
		"agent_version":    version,
		"agent_version_id": versionID,
	})
}

func (h *Handler) listReports(w http.ResponseWriter, r *http.Request) {
	viewer := viewerFrom(r)
	row, ok := h.resolveAgent(w, r, viewer, r.PathValue("agent_id"), false)
	if !ok {
		return
	}
	reports, err := h.Store.ListReports(r.Context(), rowText(row, "id"))
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	items := make([]map[string]any, 0, len(reports))
	for _, rep := range reports {
		items = append(items, rep.ListItem())
	}
	httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) getReport(w http.ResponseWriter, r *http.Request) {
	viewer := viewerFrom(r)
	report, err := h.Store.GetReport(r.Context(), strings.TrimSpace(r.PathValue("report_id")))
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if report == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Report not found")
		return
	}
	if !h.authorizeReport(w, r, viewer, report.AgentID) {
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, report.Detail())
}

// getAgentReport resolves the agent first, then requires the report to
// belong to it.
func (h *Handler) getAgentReport(w http.ResponseWriter, r *http.Request) {
	viewer := viewerFrom(r)
	row, ok := h.resolveAgent(w, r, viewer, r.PathValue("agent_id"), false)
	if !ok {
		return
	}
	report, err := h.Store.GetReport(r.Context(), strings.TrimSpace(r.PathValue("report_id")))
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if report == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Report not found")
		return
	}
	if !h.authorizeReport(w, r, viewer, report.AgentID) {
		return
	}
	if report.AgentID != rowText(row, "id") {
		httpapi.WriteError(w, http.StatusNotFound, "Report not found for agent")
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, report.Detail())
}

func (h *Handler) clearAgentReports(w http.ResponseWriter, r *http.Request) {
	viewer := viewerFrom(r)
	row, ok := h.resolveAgent(w, r, viewer, r.PathValue("agent_id"), false)
	if !ok {
		return
	}
	counts, err := h.Store.DeleteAgentReports(r.Context(), rowText(row, "id"))
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"deleted_reports": counts.Reports,
		"deleted_facets":  counts.Facets,
		"deleted_cache":   counts.Cache,
	})
}

func (h *Handler) deleteReport(w http.ResponseWriter, r *http.Request) {
	viewer := viewerFrom(r)
	reportID := strings.TrimSpace(r.PathValue("report_id"))
	report, err := h.Store.GetReport(r.Context(), reportID)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if report == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Report not found")
		return
	}
	if !h.authorizeReport(w, r, viewer, report.AgentID) {
		return
	}
	if err := h.Store.DeleteReport(r.Context(), report.ID); err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"deleted": true, "report_id": reportID})
}
