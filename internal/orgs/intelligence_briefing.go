// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

type briefingMetric struct {
	Key        string   `json:"key"`
	Label      string   `json:"label"`
	Value      *float64 `json:"value"`
	Previous   *float64 `json:"previous"`
	ChangePct  *float64 `json:"change_pct"`
	Unit       string   `json:"unit"`
	Restricted bool     `json:"restricted"`
}

type briefingPoint struct {
	Date        string   `json:"date"`
	Sessions    *int     `json:"sessions"`
	ActiveUsers *int     `json:"active_users"`
	ToolCalls   *int     `json:"tool_calls"`
	Tokens      *int     `json:"tokens"`
	Credits     *float64 `json:"credits"`
}

type signalEvidence struct {
	Label string `json:"label"`
	Value any    `json:"value"`
	Unit  string `json:"unit"`
}

type signalAction struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
}

type intelligenceSignal struct {
	ID             string           `json:"id"`
	Kind           string           `json:"kind"`
	Classification string           `json:"classification"`
	Severity       string           `json:"severity"`
	Title          string           `json:"title"`
	Explanation    string           `json:"explanation"`
	Impact         string           `json:"impact"`
	AgentID        *string          `json:"agent_id"`
	QualifiedName  *string          `json:"qualified_name"`
	Evidence       []signalEvidence `json:"evidence"`
	Actions        []signalAction   `json:"actions"`
}

type adoptionBrief struct {
	ActiveUsers         *int     `json:"active_users"`
	NewUsers            *int     `json:"new_users"`
	ReturningUsers      *int     `json:"returning_users"`
	TopResourceSharePct *float64 `json:"top_resource_share_pct"`
	AttributedSessions  *int     `json:"attributed_sessions"`
}

type ownershipRow struct {
	UserID           string  `json:"user_id"`
	Name             string  `json:"name"`
	Role             string  `json:"role"`
	Department       *string `json:"department"`
	ResourcesOwned   int     `json:"resources_owned"`
	ChangesSubmitted int     `json:"changes_submitted"`
	IssuesOpened     int     `json:"issues_opened"`
	IssuesResolved   int     `json:"issues_resolved"`
}

func (h *Handler) loadOwnership(ctx context.Context, ictx *workspaceContext, since time.Time) ([]ownershipRow, error) {
	rows, err := h.Store.DB.Query(ctx,
		`SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email), pm.role::text, u.department,
		        (SELECT count(a.id) FROM agents a WHERE a.project_id = $1 AND a.created_by = u.id AND a.deleted_at IS NULL),
		        (SELECT count(v.id) FROM agent_versions v JOIN agents a ON a.id = v.agent_id
		         WHERE a.project_id = $1 AND v.released_by = u.id AND v.created_at >= $2),
		        (SELECT count(i.id) FROM review_issues i JOIN agents a ON a.id = i.subject_id
		         WHERE i.subject_type = 'agent' AND a.project_id = $1 AND i.author_id = u.id AND i.created_at >= $2),
		        (SELECT count(i.id) FROM review_issues i JOIN agents a ON a.id = i.subject_id
		         WHERE i.subject_type = 'agent' AND a.project_id = $1 AND i.resolved_by = u.id AND i.resolved_at >= $2)
		 FROM project_memberships pm JOIN users u ON u.id = pm.user_id
		 WHERE pm.project_id = $1 ORDER BY 4 DESC, 5 DESC, 2 ASC LIMIT 12`, ictx.project.ID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ownershipRow{}
	for rows.Next() {
		var userID uuid.UUID
		var row ownershipRow
		if err := rows.Scan(&userID, &row.Name, &row.Role, &row.Department, &row.ResourcesOwned, &row.ChangesSubmitted,
			&row.IssuesOpened, &row.IssuesResolved); err != nil {
			return nil, err
		}
		row.UserID = userID.String()
		out = append(out, row)
	}
	return out, rows.Err()
}

func metric(key, label, unit string, current, previous map[string]any) briefingMetric {
	value := workspaceRowFloat(current, key)
	previousValue := workspaceRowFloat(previous, key)
	return briefingMetric{
		Key: key, Label: label, Unit: unit, Value: workspaceFloatPointer(value), Previous: workspaceFloatPointer(previousValue),
		ChangePct: workspacePercentChange(value, previousValue),
	}
}

func metricByKey(metrics []briefingMetric, key string) *briefingMetric {
	for index := range metrics {
		if metrics[index].Key == key {
			return &metrics[index]
		}
	}
	return nil
}

func formatDelta(value float64) string {
	return strconv.FormatFloat(math.Abs(value), 'f', -1, 64) + "%"
}

func buildSignals(metrics []briefingMetric, resources []workspaceResource) []intelligenceSignal {
	signals := []intelligenceSignal{}
	sessions := metricByKey(metrics, "sessions")
	if sessions != nil && sessions.ChangePct != nil && sessions.Previous != nil && *sessions.Previous >= 10 && math.Abs(*sessions.ChangePct) >= 20 {
		direction := "increased"
		severity := "info"
		classification := "fact"
		impact := "More project activity is flowing through the agent estate."
		if *sessions.ChangePct < 0 {
			direction, severity, classification = "decreased", "warning", "anomaly"
			impact = "Lower activity can indicate adoption loss or missing telemetry."
		}
		signals = append(signals, intelligenceSignal{
			ID: "usage-shift", Kind: "usage_shift", Classification: classification, Severity: severity,
			Title:       fmt.Sprintf("Project usage %s %s", direction, formatDelta(*sessions.ChangePct)),
			Explanation: "Sessions are compared with the immediately preceding period of equal length.", Impact: impact,
			Evidence: []signalEvidence{{Label: "Current sessions", Value: *sessions.Value, Unit: "sessions"},
				{Label: "Previous sessions", Value: *sessions.Previous, Unit: "sessions"}},
			Actions: []signalAction{{Kind: "open_history", Label: "Review the change over time"}},
		})
	}

	cost := metricByKey(metrics, "credits")
	if cost != nil && !cost.Restricted && cost.ChangePct != nil && sessions != nil && sessions.ChangePct != nil &&
		*cost.ChangePct >= 25 && *sessions.ChangePct <= 5 {
		signals = append(signals, intelligenceSignal{
			ID: "cost-divergence", Kind: "cost_divergence", Classification: "anomaly", Severity: "warning",
			Title:       fmt.Sprintf("Cost rose %s without matching usage", formatDelta(*cost.ChangePct)),
			Explanation: "Credits grew materially while session volume stayed flat or declined.",
			Impact:      "The project is spending more per unit of activity and should inspect its largest cost drivers.",
			Evidence: []signalEvidence{{Label: "Cost change", Value: *cost.ChangePct, Unit: "%"},
				{Label: "Session change", Value: *sessions.ChangePct, Unit: "%"}},
			Actions: []signalAction{{Kind: "inspect_cost", Label: "Inspect cost drivers"}},
		})
	}

	for _, resource := range resources {
		id, qualified := resource.AgentID, resource.QualifiedName
		if len(resource.AttentionReasons) > 0 {
			severity := "warning"
			if resource.Sessions != nil && *resource.Sessions >= 10 &&
				((resource.OpenIssues != nil && *resource.OpenIssues >= 3) ||
					(resource.ToolCompletionPct != nil && *resource.ToolCompletionPct < 75)) {
				severity = "critical"
			}
			evidence := []signalEvidence{}
			if resource.Sessions != nil {
				evidence = append(evidence, signalEvidence{Label: "Sessions", Value: *resource.Sessions, Unit: "sessions"})
			}
			if resource.OpenIssues != nil {
				evidence = append(evidence, signalEvidence{Label: "Open issues", Value: *resource.OpenIssues, Unit: "issues"})
			}
			if resource.ToolCompletionPct != nil {
				evidence = append(evidence, signalEvidence{Label: "Tool completion", Value: *resource.ToolCompletionPct, Unit: "%"})
			}
			signals = append(signals, intelligenceSignal{
				ID: "attention:" + id, Kind: "resource_attention", Classification: "anomaly", Severity: severity,
				Title:       resource.Name + " needs attention",
				Explanation: strings.Join(resource.AttentionReasons, ", ") + ".",
				Impact:      "A resource with active usage and unresolved operational signals can affect the project disproportionately.",
				AgentID:     &id, QualifiedName: qualified, Evidence: evidence,
				Actions: []signalAction{{Kind: "investigate_resource", Label: "Investigate resource"},
					{Kind: "open_resource", Label: "Open resource"}},
			})
			continue
		}
		if resource.ChangePct != nil && *resource.ChangePct >= 50 && resource.Sessions != nil && *resource.Sessions >= 5 {
			signals = append(signals, intelligenceSignal{
				ID: "growth:" + id, Kind: "resource_growth", Classification: "fact", Severity: "info",
				Title:       fmt.Sprintf("%s usage grew %s", resource.Name, formatDelta(*resource.ChangePct)),
				Explanation: "Session growth is measured against the previous equal-length period.",
				Impact:      "Rapid growth can justify investment, but also increases the blast radius of regressions.",
				AgentID:     &id, QualifiedName: qualified,
				Evidence: []signalEvidence{{Label: "Current sessions", Value: *resource.Sessions, Unit: "sessions"},
					{Label: "Change", Value: *resource.ChangePct, Unit: "%"}},
				Actions: []signalAction{{Kind: "investigate_resource", Label: "Understand the growth"}},
			})
		}
	}
	ownerCounts := map[string]int{}
	registered := 0
	for _, resource := range resources {
		if resource.QualifiedName == nil {
			continue
		}
		registered++
		if resource.Owner != nil && *resource.Owner != "" {
			ownerCounts[*resource.Owner]++
		}
	}
	for owner, count := range ownerCounts {
		if registered >= 3 && count >= 2 && float64(count)/float64(registered) >= 0.6 {
			signals = append(signals, intelligenceSignal{
				ID: "ownership-concentration", Kind: "ownership_concentration", Classification: "interpretation", Severity: "warning",
				Title:       fmt.Sprintf("%s owns %d of %d resources", owner, count, registered),
				Explanation: "Maintainer concentration is calculated from current resource ownership.",
				Impact:      "A concentrated maintenance surface increases continuity and review bottleneck risk.",
				Evidence: []signalEvidence{{Label: "Resources owned", Value: count, Unit: "resources"},
					{Label: "Project resources", Value: registered, Unit: "resources"}},
				Actions: []signalAction{{Kind: "inspect_ownership", Label: "Review ownership"}},
			})
			break
		}
	}

	severityRank := map[string]int{"critical": 0, "warning": 1, "info": 2}
	sort.SliceStable(signals, func(left, right int) bool {
		return severityRank[signals[left].Severity] < severityRank[signals[right].Severity]
	})
	if len(signals) > 12 {
		signals = signals[:12]
	}
	return signals
}

func (h *Handler) intelligenceBriefing(w http.ResponseWriter, r *http.Request) {
	ictx, ok := h.workspaceResolve(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	now := time.Now().UTC()
	settings := func(days, offset int) clickhouse.Settings {
		return clickhouse.Settings{
			"param_pid": ictx.project.ID.String(), "param_days": strconv.Itoa(days), "param_offset": strconv.Itoa(offset),
		}
	}
	var currentRows, previousRows, dailyRows []map[string]any
	var adoptionRows []map[string]any
	var currentErr, previousErr, dailyErr, adoptionErr error
	var snapshot resourceSnapshot
	var snapshotErr error
	ownership := []ownershipRow{}
	var ownershipErr error
	var wait sync.WaitGroup
	wait.Add(6)
	go func() {
		defer wait.Done()
		currentRows, currentErr = h.queryWorkspaceRows(ctx, aggregateWindowSQL, settings(ictx.days, 0))
	}()
	go func() {
		defer wait.Done()
		previousRows, previousErr = h.queryWorkspaceRows(ctx, aggregateWindowSQL, settings(ictx.days*2, ictx.days))
	}()
	go func() {
		defer wait.Done()
		dailyRows, dailyErr = h.queryWorkspaceRows(ctx, dailyActivitySQL, clickhouse.Settings{
			"param_pid": ictx.project.ID.String(), "param_days": strconv.Itoa(ictx.days),
		})
	}()
	go func() {
		defer wait.Done()
		adoptionRows, adoptionErr = h.queryWorkspaceRows(ctx, adoptionUsersSQL, clickhouse.Settings{
			"param_pid": ictx.project.ID.String(), "param_days": strconv.Itoa(ictx.days),
		})
	}()
	go func() {
		defer wait.Done()
		snapshot, snapshotErr = h.loadResourceSnapshot(ctx, ictx)
	}()
	go func() {
		defer wait.Done()
		ownership, ownershipErr = h.loadOwnership(ctx, ictx, now.AddDate(0, 0, -ictx.days))
	}()
	wait.Wait()
	if snapshotErr != nil {
		httpapi.WriteInternalError(w, r, snapshotErr)
		return
	}
	logResourceSourceErrors(snapshot)

	current, previous := map[string]any{}, map[string]any{}
	if currentErr == nil && len(currentRows) > 0 {
		current = currentRows[0]
	}
	if previousErr == nil && len(previousRows) > 0 {
		previous = previousRows[0]
	}
	metrics := []briefingMetric{}
	if currentErr == nil && previousErr == nil {
		metrics = append(metrics,
			metric("sessions", "Sessions", "sessions", current, previous),
			metric("active_users", "Active users", "users", current, previous),
			metric("tool_calls", "Tool calls", "calls", current, previous),
		)
		currentCalls, previousCalls := workspaceRowFloat(current, "tool_calls"), workspaceRowFloat(previous, "tool_calls")
		currentCompletion, previousCompletion := 0.0, 0.0
		if currentCalls > 0 {
			currentCompletion = workspaceRound(workspaceRowFloat(current, "tool_results")/currentCalls*100, 1)
		}
		if previousCalls > 0 {
			previousCompletion = workspaceRound(workspaceRowFloat(previous, "tool_results")/previousCalls*100, 1)
		}
		metrics = append(metrics, briefingMetric{
			Key: "tool_completion", Label: "Tool completion", Unit: "%",
			Value: workspaceFloatPointer(currentCompletion), Previous: workspaceFloatPointer(previousCompletion),
			ChangePct: workspaceFloatPointer(workspaceRound(currentCompletion-previousCompletion, 1)),
		})
		costMetric := metric("credits", "Cost", "credits", current, previous)
		costMetric.Restricted = !ictx.includeCost
		if !ictx.includeCost {
			costMetric.Value, costMetric.Previous, costMetric.ChangePct = nil, nil, nil
		}
		metrics = append(metrics, costMetric)
	}

	downloadCurrent, downloadPrevious := 0, 0
	for _, resource := range snapshot.rows {
		if resource.Downloads != nil {
			downloadCurrent += *resource.Downloads
		}
		if resource.PreviousDownloads != nil {
			downloadPrevious += *resource.PreviousDownloads
		}
	}
	if snapshot.downloadsErr == nil {
		metrics = append(metrics, briefingMetric{
			Key: "downloads", Label: "Installs", Unit: "installs",
			Value: workspaceFloatPointer(float64(downloadCurrent)), Previous: workspaceFloatPointer(float64(downloadPrevious)),
			ChangePct: workspacePercentChange(float64(downloadCurrent), float64(downloadPrevious)),
		})
	}

	activity := []briefingPoint{}
	if dailyErr == nil {
		for _, row := range dailyRows {
			point := briefingPoint{
				Date: fmt.Sprintf("%v", row["day"]), Sessions: workspaceIntPointer(int(workspaceRowFloat(row, "sessions"))),
				ActiveUsers: workspaceIntPointer(int(workspaceRowFloat(row, "active_users"))), ToolCalls: workspaceIntPointer(int(workspaceRowFloat(row, "tool_calls"))),
				Tokens: workspaceIntPointer(int(workspaceRowFloat(row, "tokens"))),
			}
			if ictx.includeCost {
				point.Credits = workspaceFloatPointer(workspaceRound(workspaceRowFloat(row, "credits"), 4))
			}
			activity = append(activity, point)
		}
	}
	adoption := adoptionBrief{}
	if adoptionErr == nil && len(adoptionRows) > 0 {
		activeUsers := int(workspaceRowFloat(adoptionRows[0], "active_users"))
		newUsers := int(workspaceRowFloat(adoptionRows[0], "new_users"))
		returningUsers := max(0, activeUsers-newUsers)
		adoption.ActiveUsers = workspaceIntPointer(activeUsers)
		adoption.NewUsers = workspaceIntPointer(newUsers)
		adoption.ReturningUsers = workspaceIntPointer(returningUsers)
	}
	attributedSessions, topSessions := 0, 0
	for _, resource := range snapshot.rows {
		if resource.Sessions == nil {
			continue
		}
		attributedSessions += *resource.Sessions
		topSessions = max(topSessions, *resource.Sessions)
	}
	if snapshot.telemetryErr == nil {
		adoption.AttributedSessions = workspaceIntPointer(attributedSessions)
		if attributedSessions > 0 {
			adoption.TopResourceSharePct = workspaceFloatPointer(workspaceRound(float64(topSessions)/float64(attributedSessions)*100, 1))
		}
	}

	telemetryStatus := "fresh"
	telemetryMessage := ""
	if currentErr != nil || previousErr != nil || dailyErr != nil || adoptionErr != nil || snapshot.telemetryErr != nil {
		telemetryStatus = "partial"
		telemetryMessage = "Some telemetry aggregates are unavailable; unavailable metrics are omitted."
		if currentErr != nil && previousErr != nil && dailyErr != nil && adoptionErr != nil && snapshot.telemetryErr != nil {
			telemetryStatus = "unavailable"
		}
	}
	sources := resourceSources(snapshot)
	for index := range sources {
		if sources[index].Name == "telemetry" {
			sources[index] = workspaceSourceState("telemetry", telemetryStatus, telemetryMessage, now)
		}
	}
	if ownershipErr != nil {
		sources = append(sources, workspaceSourceState("ownership", "unavailable", "Contributor accountability is temporarily unavailable.", now))
	} else {
		sources = append(sources, workspaceSourceState("ownership", "fresh", "", now))
	}

	highlights := append([]workspaceResource(nil), snapshot.rows...)
	sortResourceRows(highlights, "attention")
	if len(highlights) > 6 {
		highlights = highlights[:6]
	}
	signals := buildSignals(metrics, snapshot.rows)
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"range": ictx.rng, "comparison": "previous_" + ictx.rng,
		"generated_at": now.Format(time.RFC3339), "sources": sources,
		"has_data": len(activity) > 0 || len(snapshot.rows) > 0,
		"metrics":  metrics, "activity": activity, "signals": signals,
		"resource_highlights": highlights, "adoption": adoption, "ownership": ownership,
	})
}
