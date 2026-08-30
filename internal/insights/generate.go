// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insights

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/insightsgen"
)

// generateRequest selects the report window and version scope.
type generateRequest struct {
	PeriodDays             int     `json:"period_days"`
	AgentVersion           *string `json:"agent_version"`
	ComparisonAgentVersion *string `json:"comparison_agent_version"`
	VersionScope           *string `json:"version_scope"`
}

// applyRequest selects which suggestions to apply; a missing field skips
// that category, an empty body applies everything.
type applyRequest struct {
	ConfigIndices  []int `json:"config_indices"`
	FeatureIndices []int `json:"feature_indices"`
	PatternIndices []int `json:"pattern_indices"`
}

func decodeOptional(r *http.Request, dst any) error {
	if r.Body == nil {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	return json.Unmarshal([]byte(trimmed), dst)
}

// status reports whether generation is configured and reachable.
func (h *Handler) status(w http.ResponseWriter, r *http.Request) {
	if h.Engine == nil {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"available": false, "reason": "Insights service is unavailable.",
		})
		return
	}
	available, reason := h.Engine.Availability(r.Context())
	var wireReason any
	if reason != "" {
		wireReason = reason
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"available": available, "reason": wireReason})
}

// parseSemver reads a MAJOR.MINOR.PATCH version; anything else sorts lowest.
func parseSemver(v string) [3]int {
	parts := strings.SplitN(strings.TrimSpace(v), ".", 3)
	if len(parts) != 3 {
		return [3]int{}
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || n < 0 {
			return [3]int{}
		}
		out[i] = n
	}
	return out
}

func semverLess(a, b [3]int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// previousApprovedVersion returns the newest approved version older than
// the current one; the default comparison target for a report.
func (s *Store) previousApprovedVersion(ctx context.Context, agentID, currentVersionID, currentVersion string) (id, version string, err error) {
	rows, err := s.DB.Query(ctx,
		`SELECT id::text, version FROM agent_versions
		 WHERE agent_id = $1 AND status = 'approved' AND id::text <> $2`,
		agentID, currentVersionID)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	current := parseSemver(currentVersion)
	type cand struct {
		id, version string
		parsed      [3]int
	}
	var older []cand
	for rows.Next() {
		var c cand
		if err := rows.Scan(&c.id, &c.version); err != nil {
			return "", "", err
		}
		c.parsed = parseSemver(c.version)
		if semverLess(c.parsed, current) {
			older = append(older, c)
		}
	}
	if err := rows.Err(); err != nil {
		return "", "", err
	}
	if len(older) == 0 {
		return "", "", nil
	}
	sort.Slice(older, func(i, j int) bool { return semverLess(older[j].parsed, older[i].parsed) })
	return older[0].id, older[0].version, nil
}

// previousCompletedReport links regressions to the last finished report
// for the same agent version.
func (s *Store) previousCompletedReport(ctx context.Context, agentID, agentVersion string) (string, error) {
	var id string
	err := s.DB.QueryRow(ctx,
		`SELECT id::text FROM insight_reports
		 WHERE agent_id = $1 AND agent_version = $2 AND status = 'completed'
		 ORDER BY created_at DESC LIMIT 1`,
		agentID, agentVersion).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// createReport inserts the queued report row and returns its wire row.
func (s *Store) createReport(ctx context.Context, p reportParams) (*Report, error) {
	sql := `INSERT INTO insight_reports (
			agent_id, triggered_by, status, period_start, period_end, started_at,
			previous_report_id, agent_version_id, agent_version, version_scope,
			comparison_agent_version_id, comparison_agent_version,
			progress_phase, progress_message, progress_updated_at)
		VALUES ($1, $2, 'pending', $3, $4, $5,
			NULLIF($6, '')::uuid, $7, $8, $9,
			NULLIF($10, '')::uuid, NULLIF($11, ''),
			'queued', 'Queued for generation', $5)
		RETURNING ` + reportColumns
	row := s.DB.QueryRow(ctx, sql,
		p.agentID, p.triggeredBy, p.periodStart, p.periodEnd, p.now,
		p.previousReportID, p.versionID, p.version, p.versionScope,
		p.comparisonVersionID, p.comparisonVersion)
	return scanReport(row)
}

type reportParams struct {
	agentID, triggeredBy        string
	periodStart, periodEnd, now time.Time
	previousReportID            string
	versionID, version          string
	versionScope                string
	comparisonVersionID         string
	comparisonVersion           string
}

// generate queues an insight report for the agent and wakes the runner.
func (h *Handler) generate(w http.ResponseWriter, r *http.Request) {
	viewer := viewerFrom(r)
	row, ok := h.resolveAgent(w, r, viewer, r.PathValue("agent_id"), false)
	if !ok {
		return
	}
	req := generateRequest{PeriodDays: 14}
	if err := decodeOptional(r, &req); err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if req.PeriodDays <= 0 {
		req.PeriodDays = 14
	}
	versionScope := "canonical_and_dirty"
	if req.VersionScope != nil && *req.VersionScope != "" {
		versionScope = *req.VersionScope
	}
	agentID, agentName := rowText(row, "id"), rowText(row, "name")

	requested := ""
	if req.AgentVersion != nil {
		requested = *req.AgentVersion
	}
	versionID, version, err := h.Store.ApprovedVersion(r.Context(), agentID, requested)
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

	var comparisonID, comparisonVersion string
	if req.ComparisonAgentVersion != nil && *req.ComparisonAgentVersion != "" {
		comparisonID, comparisonVersion, err = h.Store.ApprovedVersion(r.Context(), agentID, *req.ComparisonAgentVersion)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if comparisonID == "" {
			httpapi.WriteError(w, http.StatusNotFound,
				fmt.Sprintf("Approved version '%s' not found", *req.ComparisonAgentVersion))
			return
		}
	} else {
		comparisonID, comparisonVersion, err = h.Store.previousApprovedVersion(r.Context(), agentID, versionID, version)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
	}

	now := time.Now().UTC()
	periodStart := now.Add(-time.Duration(req.PeriodDays) * 24 * time.Hour)
	if h.Store.SessionCount(r.Context(), agentID, agentName, periodStart, now, version) == 0 {
		httpapi.WriteError(w, http.StatusUnprocessableEntity,
			fmt.Sprintf("No sessions found for this agent version (%s) in the last %d days. Cannot generate a report.",
				version, req.PeriodDays))
		return
	}

	previousReportID, err := h.Store.previousCompletedReport(r.Context(), agentID, version)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}

	triggeredBy := ""
	if viewer != nil {
		triggeredBy = viewer.ID.String()
	}
	report, err := h.Store.createReport(r.Context(), reportParams{
		agentID: agentID, triggeredBy: triggeredBy,
		periodStart: periodStart, periodEnd: now, now: now,
		previousReportID: previousReportID,
		versionID:        versionID, version: version, versionScope: versionScope,
		comparisonVersionID: comparisonID, comparisonVersion: comparisonVersion,
	})
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if h.Gen != nil {
		h.Gen.Enqueue()
	}
	httpapi.WriteJSON(w, http.StatusOK, report.ListItem())
}

// loadCompletedReport resolves and authorizes a report for export.
func (h *Handler) loadReportForExport(w http.ResponseWriter, r *http.Request, reportID string) (*Report, bool) {
	report, err := h.Store.GetReport(r.Context(), reportID)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return nil, false
	}
	if report == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Report not found")
		return nil, false
	}
	if report.Status != "completed" {
		httpapi.WriteError(w, http.StatusBadRequest, "Report is not yet completed")
		return nil, false
	}
	if !h.authorizeReport(w, r, viewerFrom(r), report.AgentID) {
		return nil, false
	}
	return report, true
}

func (h *Handler) writeReportHTML(w http.ResponseWriter, r *http.Request, report *Report, reportID string) {
	doc, err := insightsgen.RenderReportHTML(map[string]any{
		"id":                       report.ID,
		"agent_id":                 report.AgentID,
		"agent_version":            strOrNil(report.AgentVersion),
		"comparison_agent_version": strOrNil(report.ComparisonAgentVersion),
		"status":                   report.Status,
		"period_start":             report.PeriodStart,
		"period_end":               report.PeriodEnd,
		"metrics":                  report.Metrics,
		"narrative":                report.Narrative,
		"sessions_analyzed":        report.SessionsAnalyzed,
	}, "")
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	short := reportID
	if len(short) > 8 {
		short = short[:8]
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", "insight-report-"+short+".html"))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(doc))
}

// exportHTML renders a completed report as a standalone document.
func (h *Handler) exportHTML(w http.ResponseWriter, r *http.Request) {
	reportID := strings.TrimSpace(r.PathValue("report_id"))
	report, ok := h.loadReportForExport(w, r, reportID)
	if !ok {
		return
	}
	h.writeReportHTML(w, r, report, reportID)
}

// exportAgentHTML is the agent-scoped export; the report must belong to
// the resolved agent.
func (h *Handler) exportAgentHTML(w http.ResponseWriter, r *http.Request) {
	viewer := viewerFrom(r)
	row, ok := h.resolveAgent(w, r, viewer, r.PathValue("agent_id"), false)
	if !ok {
		return
	}
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
	if report.AgentID != rowText(row, "id") {
		httpapi.WriteError(w, http.StatusNotFound, "Report not found for agent")
		return
	}
	if report.Status != "completed" {
		httpapi.WriteError(w, http.StatusBadRequest, "Report is not yet completed")
		return
	}
	h.writeReportHTML(w, r, report, reportID)
}

func (h *Handler) applySelection(r *http.Request, w http.ResponseWriter) (*insightsgen.ApplySelection, bool) {
	var req applyRequest
	if err := decodeOptional(r, &req); err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid request body")
		return nil, false
	}
	if req.ConfigIndices == nil && req.FeatureIndices == nil && req.PatternIndices == nil {
		return nil, true
	}
	return &insightsgen.ApplySelection{
		ConfigIndices:  req.ConfigIndices,
		FeatureIndices: req.FeatureIndices,
		PatternIndices: req.PatternIndices,
	}, true
}

func (h *Handler) selfLearnEnabled(w http.ResponseWriter, r *http.Request) bool {
	if h.Config != nil && !h.Config.Bool(r.Context(), "insights.self_learn_enabled", true) {
		httpapi.WriteError(w, http.StatusForbidden,
			"Self-learning is disabled. Enable via settings: insights.self_learn_enabled")
		return false
	}
	return true
}

func (h *Handler) runApply(w http.ResponseWriter, r *http.Request, reportID, agentID string, selection *insightsgen.ApplySelection) {
	viewer := viewerFrom(r)
	actor := ""
	if viewer != nil {
		actor = viewer.ID.String()
	}
	result, err := h.GenStore.ApplyReport(r.Context(), reportID, agentID, actor, selection)
	if err != nil {
		var applyErr *insightsgen.ApplyError
		if errors.As(err, &applyErr) {
			httpapi.WriteError(w, applyErr.Status, applyErr.Detail)
			return
		}
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, result)
}

// applyReport applies a completed report's suggestions to the agent draft.
func (h *Handler) applyReport(w http.ResponseWriter, r *http.Request) {
	if !h.selfLearnEnabled(w, r) {
		return
	}
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
	if !h.authorizeReport(w, r, viewerFrom(r), report.AgentID) {
		return
	}
	selection, ok := h.applySelection(r, w)
	if !ok {
		return
	}
	h.runApply(w, r, reportID, "", selection)
}

// applyAgentReport is the agent-scoped apply; the report must belong to
// the resolved agent.
func (h *Handler) applyAgentReport(w http.ResponseWriter, r *http.Request) {
	viewer := viewerFrom(r)
	row, ok := h.resolveAgent(w, r, viewer, r.PathValue("agent_id"), false)
	if !ok {
		return
	}
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
	agentID := rowText(row, "id")
	if report.AgentID != agentID {
		httpapi.WriteError(w, http.StatusNotFound, "Report not found for agent")
		return
	}
	if !h.selfLearnEnabled(w, r) {
		return
	}
	selection, ok := h.applySelection(r, w)
	if !ok {
		return
	}
	h.runApply(w, r, reportID, agentID, selection)
}
