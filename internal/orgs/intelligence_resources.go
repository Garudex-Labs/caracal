// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

var (
	resourceFocusRe = regexp.MustCompile(`^(all|attention|growing|declining|underused)$`)
	resourceSortRe  = regexp.MustCompile(`^(impact|attention|growth|cost|name)$`)
)

type resourceMeta struct {
	id                    uuid.UUID
	name, namespace, slug string
	owner                 string
	version, status       *string
	updatedAt             time.Time
}

type periodCounts struct {
	current  int
	previous int
}

type workspaceResource struct {
	AgentID           string   `json:"agent_id"`
	Name              string   `json:"name"`
	QualifiedName     *string  `json:"qualified_name"`
	Owner             *string  `json:"owner"`
	Version           *string  `json:"version"`
	Status            *string  `json:"status"`
	Sessions          *int     `json:"sessions"`
	PreviousSessions  *int     `json:"previous_sessions"`
	ChangePct         *float64 `json:"change_pct"`
	ToolCalls         *int     `json:"tool_calls"`
	ToolCompletionPct *float64 `json:"tool_completion_pct"`
	Tokens            *int     `json:"tokens"`
	Credits           *float64 `json:"credits"`
	CreditsPerSession *float64 `json:"credits_per_session"`
	Downloads         *int     `json:"downloads"`
	PreviousDownloads *int     `json:"previous_downloads"`
	OpenIssues        *int     `json:"open_issues"`
	ResolvedIssues    *int     `json:"resolved_issues"`
	LastUsed          *string  `json:"last_used"`
	UpdatedAt         *string  `json:"updated_at"`
	AttentionReasons  []string `json:"attention_reasons"`
}

type resourceSnapshot struct {
	rows           []workspaceResource
	telemetryErr   error
	downloadsErr   error
	issuesErr      error
	generatedAt    time.Time
	costRestricted bool
}

type resourceVersionRow struct {
	Version           string   `json:"version"`
	Status            string   `json:"status"`
	ReleasedAt        *string  `json:"released_at"`
	Sessions          *int     `json:"sessions"`
	ToolCalls         *int     `json:"tool_calls"`
	ToolCompletionPct *float64 `json:"tool_completion_pct"`
	Tokens            *int     `json:"tokens"`
	Credits           *float64 `json:"credits"`
}

func (h *Handler) loadResourceSnapshot(ctx context.Context, ictx *workspaceContext) (resourceSnapshot, error) {
	now := time.Now().UTC()
	snapshot := resourceSnapshot{rows: []workspaceResource{}, generatedAt: now, costRestricted: !ictx.includeCost}

	telemetryRows, telemetryErr := h.queryWorkspaceRows(ctx, resourceWindowSQL, clickhouse.Settings{
		"param_pid":   ictx.project.ID.String(),
		"param_days":  fmt.Sprintf("%d", ictx.days),
		"param_days2": fmt.Sprintf("%d", ictx.days*2),
	})
	snapshot.telemetryErr = telemetryErr
	usage := map[string]map[string]any{}
	for _, row := range telemetryRows {
		usage[fmt.Sprintf("%v", row["agent_id"])] = row
	}

	agentRows, err := h.Store.DB.Query(ctx,
		`SELECT a.id, a.name, a.namespace, a.slug, a.owner,
		        v.version, v.status::text, a.updated_at
		 FROM agents a LEFT JOIN agent_versions v ON a.latest_version_id = v.id
		 WHERE a.project_id = $1 AND a.deleted_at IS NULL`, ictx.project.ID)
	if err != nil {
		return snapshot, err
	}
	agents := []resourceMeta{}
	for agentRows.Next() {
		var agent resourceMeta
		if err := agentRows.Scan(&agent.id, &agent.name, &agent.namespace, &agent.slug,
			&agent.owner, &agent.version, &agent.status, &agent.updatedAt); err != nil {
			agentRows.Close()
			return snapshot, err
		}
		agents = append(agents, agent)
	}
	agentRows.Close()
	if err := agentRows.Err(); err != nil {
		return snapshot, err
	}

	ids := make([]uuid.UUID, len(agents))
	for index, agent := range agents {
		ids[index] = agent.id
	}
	downloads := map[string]periodCounts{}
	issues := map[string]periodCounts{}
	currentStart := now.AddDate(0, 0, -ictx.days)
	previousStart := now.AddDate(0, 0, -ictx.days*2)
	if len(ids) > 0 {
		downloadRows, queryErr := h.Store.DB.Query(ctx,
			`SELECT agent_id,
			        count(id) FILTER (WHERE installed_at > $2),
			        count(id) FILTER (WHERE installed_at > $3 AND installed_at <= $2)
			 FROM agent_download_records
			 WHERE agent_id = ANY($1) AND installed_at > $3 GROUP BY agent_id`,
			ids, currentStart, previousStart)
		if queryErr != nil {
			snapshot.downloadsErr = queryErr
		} else {
			for downloadRows.Next() {
				var id uuid.UUID
				var counts periodCounts
				if err := downloadRows.Scan(&id, &counts.current, &counts.previous); err != nil {
					downloadRows.Close()
					return snapshot, err
				}
				downloads[id.String()] = counts
			}
			downloadRows.Close()
			if err := downloadRows.Err(); err != nil {
				return snapshot, err
			}
		}

		issueRows, queryErr := h.Store.DB.Query(ctx,
			`SELECT subject_id,
			        count(id) FILTER (WHERE status = 'open'),
			        count(id) FILTER (WHERE status = 'resolved')
			 FROM review_issues
			 WHERE subject_type = 'agent' AND subject_id = ANY($1)
			 GROUP BY subject_id`, ids)
		if queryErr != nil {
			snapshot.issuesErr = queryErr
		} else {
			for issueRows.Next() {
				var id uuid.UUID
				var counts periodCounts
				if err := issueRows.Scan(&id, &counts.current, &counts.previous); err != nil {
					issueRows.Close()
					return snapshot, err
				}
				issues[id.String()] = counts
			}
			issueRows.Close()
			if err := issueRows.Err(); err != nil {
				return snapshot, err
			}
		}
	}

	seen := map[string]bool{}
	for _, agent := range agents {
		id := agent.id.String()
		seen[id] = true
		qualified := agent.namespace + "/" + agent.slug
		owner := agent.owner
		updatedAt := agent.updatedAt.UTC().Format(time.RFC3339)
		row := workspaceResource{
			AgentID: id, Name: agent.name, QualifiedName: &qualified, Owner: &owner,
			Version: agent.version, Status: agent.status, UpdatedAt: &updatedAt,
			AttentionReasons: []string{},
		}
		applyResourceMetrics(&row, usage[id], telemetryErr, ictx.includeCost)
		if snapshot.downloadsErr == nil {
			counts := downloads[id]
			row.Downloads = workspaceIntPointer(counts.current)
			row.PreviousDownloads = workspaceIntPointer(counts.previous)
		}
		if snapshot.issuesErr == nil {
			counts := issues[id]
			row.OpenIssues = workspaceIntPointer(counts.current)
			row.ResolvedIssues = workspaceIntPointer(counts.previous)
		}
		row.AttentionReasons = resourceAttention(row)
		snapshot.rows = append(snapshot.rows, row)
	}

	if telemetryErr == nil {
		for _, usageRow := range telemetryRows {
			id := fmt.Sprintf("%v", usageRow["agent_id"])
			if seen[id] {
				continue
			}
			row := workspaceResource{
				AgentID: id, Name: "unregistered (" + workspaceShortID(id) + "…)", AttentionReasons: []string{"unregistered usage"},
			}
			applyResourceMetrics(&row, usageRow, nil, ictx.includeCost)
			snapshot.rows = append(snapshot.rows, row)
		}
	}
	return snapshot, nil
}

func applyResourceMetrics(row *workspaceResource, usage map[string]any, telemetryErr error, includeCost bool) {
	if telemetryErr != nil {
		return
	}
	sessions := int(workspaceRowFloat(usage, "sessions"))
	previous := int(workspaceRowFloat(usage, "previous_sessions"))
	toolCalls := int(workspaceRowFloat(usage, "tool_calls"))
	toolResults := int(workspaceRowFloat(usage, "tool_results"))
	tokens := int(workspaceRowFloat(usage, "tokens"))
	row.Sessions = workspaceIntPointer(sessions)
	row.PreviousSessions = workspaceIntPointer(previous)
	row.ChangePct = workspacePercentChange(float64(sessions), float64(previous))
	row.ToolCalls = workspaceIntPointer(toolCalls)
	row.Tokens = workspaceIntPointer(tokens)
	row.LastUsed = workspaceRowTimestamp(usage, "last_used")
	if toolCalls > 0 {
		row.ToolCompletionPct = workspaceFloatPointer(workspaceRound(float64(toolResults)/float64(toolCalls)*100, 1))
	}
	if includeCost {
		credits := workspaceRound(workspaceRowFloat(usage, "credits"), 4)
		row.Credits = &credits
		if sessions > 0 {
			row.CreditsPerSession = workspaceFloatPointer(workspaceRound(credits/float64(sessions), 4))
		}
	}
}

func resourceAttention(row workspaceResource) []string {
	reasons := []string{}
	if row.OpenIssues != nil && *row.OpenIssues > 0 {
		reasons = append(reasons, "open review issues")
	}
	if row.ToolCalls != nil && *row.ToolCalls >= 20 && row.ToolCompletionPct != nil && *row.ToolCompletionPct < 75 {
		reasons = append(reasons, "low tool completion")
	}
	if row.ChangePct != nil && *row.ChangePct <= -25 && row.PreviousSessions != nil && *row.PreviousSessions >= 5 {
		reasons = append(reasons, "declining usage")
	}
	if row.Downloads != nil && *row.Downloads >= 3 && row.Sessions != nil && *row.Sessions == 0 {
		reasons = append(reasons, "installed but unused")
	}
	return reasons
}

func workspaceShortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func resourceSources(snapshot resourceSnapshot) []workspaceSource {
	now := snapshot.generatedAt
	sources := []workspaceSource{}
	if snapshot.telemetryErr != nil {
		sources = append(sources, workspaceSourceState("telemetry", "unavailable", "Usage aggregates are temporarily unavailable.", now))
	} else {
		sources = append(sources, workspaceSourceState("telemetry", "fresh", "", now))
	}
	registryStatus := "fresh"
	registryMessage := ""
	if snapshot.downloadsErr != nil || snapshot.issuesErr != nil {
		registryStatus = "partial"
		registryMessage = "Some install or review-issue fields are unavailable."
	}
	sources = append(sources, workspaceSourceState("registry", registryStatus, registryMessage, now))
	switch {
	case snapshot.costRestricted:
		sources = append(sources, workspaceSourceState("cost", "restricted", "Cost visibility requires project administration access.", now))
	case snapshot.telemetryErr != nil:
		sources = append(sources, workspaceSourceState("cost", "unavailable", "Cost aggregates are temporarily unavailable.", now))
	default:
		sources = append(sources, workspaceSourceState("cost", "fresh", "", now))
	}
	return sources
}

func filterResourceRows(rows []workspaceResource, focus, search string) []workspaceResource {
	filtered := make([]workspaceResource, 0, len(rows))
	needle := strings.ToLower(strings.TrimSpace(search))
	for _, row := range rows {
		if needle != "" {
			identity := strings.ToLower(row.Name)
			if row.QualifiedName != nil {
				identity += " " + strings.ToLower(*row.QualifiedName)
			}
			if row.Owner != nil {
				identity += " " + strings.ToLower(*row.Owner)
			}
			if !strings.Contains(identity, needle) {
				continue
			}
		}
		switch focus {
		case "attention":
			if len(row.AttentionReasons) == 0 {
				continue
			}
		case "growing":
			if row.ChangePct == nil || *row.ChangePct < 25 {
				continue
			}
		case "declining":
			if row.ChangePct == nil || *row.ChangePct > -25 {
				continue
			}
		case "underused":
			found := false
			for _, reason := range row.AttentionReasons {
				found = found || reason == "installed but unused"
			}
			if !found {
				continue
			}
		}
		filtered = append(filtered, row)
	}
	return filtered
}

func sortResourceRows(rows []workspaceResource, order string) {
	value := func(pointer *int) int {
		if pointer == nil {
			return -1
		}
		return *pointer
	}
	floatValue := func(pointer *float64) float64 {
		if pointer == nil {
			return -math.MaxFloat64
		}
		return *pointer
	}
	sort.SliceStable(rows, func(left, right int) bool {
		a, b := rows[left], rows[right]
		switch order {
		case "name":
			return strings.ToLower(a.Name) < strings.ToLower(b.Name)
		case "growth":
			return floatValue(a.ChangePct) > floatValue(b.ChangePct)
		case "cost":
			return floatValue(a.Credits) > floatValue(b.Credits)
		case "attention":
			if len(a.AttentionReasons) != len(b.AttentionReasons) {
				return len(a.AttentionReasons) > len(b.AttentionReasons)
			}
		default:
			if value(a.Sessions) != value(b.Sessions) {
				return value(a.Sessions) > value(b.Sessions)
			}
		}
		if value(a.Downloads) != value(b.Downloads) {
			return value(a.Downloads) > value(b.Downloads)
		}
		return a.AgentID < b.AgentID
	})
}

func (h *Handler) intelligenceResourceIndex(w http.ResponseWriter, r *http.Request) {
	ictx, ok := h.workspaceResolve(w, r)
	if !ok {
		return
	}
	page, ok := workspaceIntQueryParam(w, r, "page", 1, 10000)
	if !ok {
		return
	}
	pageSize, ok := workspaceIntQueryParam(w, r, "page_size", 25, 100)
	if !ok {
		return
	}
	focus := r.URL.Query().Get("focus")
	if focus == "" {
		focus = "all"
	}
	if !resourceFocusRe.MatchString(focus) {
		writeWorkspacePattern422(w, "focus", focus, resourceFocusRe.String())
		return
	}
	order := r.URL.Query().Get("sort")
	if order == "" {
		order = "impact"
	}
	if !resourceSortRe.MatchString(order) {
		writeWorkspacePattern422(w, "sort", order, resourceSortRe.String())
		return
	}
	snapshot, err := h.loadResourceSnapshot(r.Context(), ictx)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	logResourceSourceErrors(snapshot)
	rows := filterResourceRows(snapshot.rows, focus, r.URL.Query().Get("search"))
	sortResourceRows(rows, order)
	total := len(rows)
	start := (page - 1) * pageSize
	if start > total {
		start = total
	}
	end := min(start+pageSize, total)
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"range": ictx.rng, "generated_at": snapshot.generatedAt.Format(time.RFC3339),
		"sources": resourceSources(snapshot), "cost_restricted": snapshot.costRestricted,
		"rows": rows[start:end], "total": total, "page": page, "page_size": pageSize,
	})
}

func compareIntMetric(left, right *int) *float64 {
	if left == nil || right == nil {
		return nil
	}
	return workspacePercentChange(float64(*right), float64(*left))
}

func compareFloatMetric(left, right *float64) *float64 {
	if left == nil || right == nil {
		return nil
	}
	return workspacePercentChange(*right, *left)
}

func (h *Handler) intelligenceResourceCompare(w http.ResponseWriter, r *http.Request) {
	ictx, ok := h.workspaceResolve(w, r)
	if !ok {
		return
	}
	leftID, rightID := r.URL.Query().Get("a"), r.URL.Query().Get("b")
	if leftID == "" || rightID == "" || leftID == rightID {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "a and b must identify two different resources")
		return
	}
	snapshot, err := h.loadResourceSnapshot(r.Context(), ictx)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	logResourceSourceErrors(snapshot)
	var left, right *workspaceResource
	for index := range snapshot.rows {
		switch snapshot.rows[index].AgentID {
		case leftID:
			left = &snapshot.rows[index]
		case rightID:
			right = &snapshot.rows[index]
		}
	}
	if left == nil || right == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Resource not found")
		return
	}
	var completionDelta *float64
	if left.ToolCompletionPct != nil && right.ToolCompletionPct != nil {
		completionDelta = workspaceFloatPointer(workspaceRound(*right.ToolCompletionPct-*left.ToolCompletionPct, 1))
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"range": ictx.rng, "generated_at": snapshot.generatedAt.Format(time.RFC3339),
		"sources": resourceSources(snapshot), "a": left, "b": right,
		"deltas": map[string]any{
			"sessions_pct":          compareIntMetric(left.Sessions, right.Sessions),
			"tool_calls_pct":        compareIntMetric(left.ToolCalls, right.ToolCalls),
			"tokens_pct":            compareIntMetric(left.Tokens, right.Tokens),
			"downloads_pct":         compareIntMetric(left.Downloads, right.Downloads),
			"credits_pct":           compareFloatMetric(left.Credits, right.Credits),
			"tool_completion_delta": completionDelta,
		},
	})
}

func (h *Handler) intelligenceResourceVersions(w http.ResponseWriter, r *http.Request) {
	ictx, ok := h.workspaceResolve(w, r)
	if !ok {
		return
	}
	resourceID, err := uuid.Parse(r.PathValue("resource"))
	if err != nil {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "resource must be a UUID")
		return
	}
	ctx := r.Context()
	var exists bool
	if err := h.Store.DB.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM agents WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL)`,
		resourceID, ictx.project.ID).Scan(&exists); err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if !exists {
		httpapi.WriteError(w, http.StatusNotFound, "Resource not found")
		return
	}

	telemetryRows, telemetryErr := h.queryWorkspaceRows(ctx,
		`SELECT agent_version, count() AS sessions, sum(tool_call_count) AS tool_calls,
		 sum(tool_result_count) AS tool_results, sum(input_tokens) + sum(output_tokens) AS tokens,
		 sum(total_credits) AS credits
		 FROM session_stats_agg FINAL
		 WHERE project_id = {pid:String} AND agent_id = {agent_id:String} AND agent_version != ''
		 AND last_event_time > now() - INTERVAL {days:UInt32} DAY
		 GROUP BY agent_version
		 SETTINGS do_not_merge_across_partitions_select_final = 1 FORMAT JSON`, clickhouse.Settings{
			"param_pid": ictx.project.ID.String(), "param_agent_id": resourceID.String(),
			"param_days": fmt.Sprintf("%d", ictx.days),
		})
	metrics := map[string]map[string]any{}
	for _, row := range telemetryRows {
		metrics[fmt.Sprintf("%v", row["agent_version"])] = row
	}

	versionRows, err := h.Store.DB.Query(ctx,
		`SELECT version, status::text, released_at FROM agent_versions
		 WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20`, resourceID)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	versions := []resourceVersionRow{}
	for versionRows.Next() {
		var row resourceVersionRow
		var releasedAt *time.Time
		if err := versionRows.Scan(&row.Version, &row.Status, &releasedAt); err != nil {
			versionRows.Close()
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if releasedAt != nil {
			formatted := releasedAt.UTC().Format(time.RFC3339)
			row.ReleasedAt = &formatted
		}
		if telemetryErr == nil {
			usage := metrics[row.Version]
			sessions := int(workspaceRowFloat(usage, "sessions"))
			toolCalls := int(workspaceRowFloat(usage, "tool_calls"))
			toolResults := int(workspaceRowFloat(usage, "tool_results"))
			tokens := int(workspaceRowFloat(usage, "tokens"))
			row.Sessions, row.ToolCalls, row.Tokens = workspaceIntPointer(sessions), workspaceIntPointer(toolCalls), workspaceIntPointer(tokens)
			if toolCalls > 0 {
				row.ToolCompletionPct = workspaceFloatPointer(workspaceRound(float64(toolResults)/float64(toolCalls)*100, 1))
			}
			if ictx.includeCost {
				row.Credits = workspaceFloatPointer(workspaceRound(workspaceRowFloat(usage, "credits"), 4))
			}
		}
		versions = append(versions, row)
	}
	versionRows.Close()
	if err := versionRows.Err(); err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	now := time.Now().UTC()
	sources := []workspaceSource{workspaceSourceState("registry", "fresh", "", now)}
	if telemetryErr != nil {
		sources = append(sources, workspaceSourceState("telemetry", "unavailable", "Version usage is temporarily unavailable.", now))
	} else {
		sources = append(sources, workspaceSourceState("telemetry", "fresh", "", now))
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"range": ictx.rng, "generated_at": now.Format(time.RFC3339), "sources": sources, "versions": versions,
	})
}

func logResourceSourceErrors(snapshot resourceSnapshot) {
	if snapshot.telemetryErr != nil {
		slog.Warn("intelligence telemetry source unavailable", "error", snapshot.telemetryErr)
	}
	if snapshot.downloadsErr != nil {
		slog.Warn("intelligence downloads source unavailable", "error", snapshot.downloadsErr)
	}
	if snapshot.issuesErr != nil {
		slog.Warn("intelligence issues source unavailable", "error", snapshot.issuesErr)
	}
}
