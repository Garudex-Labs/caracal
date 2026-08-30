// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

type historyEvent struct {
	ID             string           `json:"id"`
	OccurredAt     string           `json:"occurred_at"`
	Kind           string           `json:"kind"`
	Category       string           `json:"category"`
	Classification string           `json:"classification"`
	Severity       string           `json:"severity"`
	Title          string           `json:"title"`
	Detail         string           `json:"detail"`
	AgentID        *string          `json:"agent_id"`
	QualifiedName  *string          `json:"qualified_name"`
	VersionID      *string          `json:"version_id"`
	Version        *string          `json:"version"`
	IssueID        *string          `json:"issue_id"`
	Evidence       []signalEvidence `json:"evidence"`
}

func dailyShiftEvents(rows []map[string]any, includeCost bool) []historyEvent {
	events := []historyEvent{}
	for index := 1; index < len(rows); index++ {
		current, previous := rows[index], rows[index-1]
		date := fmt.Sprintf("%v", current["day"])
		occurredAt := date + "T23:59:59Z"
		currentSessions, previousSessions := workspaceRowFloat(current, "sessions"), workspaceRowFloat(previous, "sessions")
		if previousSessions >= 5 {
			change := workspacePercentChange(currentSessions, previousSessions)
			if change != nil && (*change >= 30 || *change <= -30) {
				direction, severity := "increased", "info"
				if *change < 0 {
					direction, severity = "decreased", "warning"
				}
				events = append(events, historyEvent{
					ID: "usage:" + date, OccurredAt: occurredAt, Kind: "usage_shift", Category: "usage",
					Classification: "fact", Severity: severity,
					Title:  fmt.Sprintf("Project usage %s %s", direction, formatDelta(*change)),
					Detail: "Daily sessions compared with the previous day.",
					Evidence: []signalEvidence{{Label: "Sessions", Value: currentSessions, Unit: "sessions"},
						{Label: "Previous day", Value: previousSessions, Unit: "sessions"}},
				})
			}
		}
		if includeCost {
			currentCost, previousCost := workspaceRowFloat(current, "credits"), workspaceRowFloat(previous, "credits")
			change := workspacePercentChange(currentCost, previousCost)
			if previousCost > 0 && change != nil && (*change >= 30 || *change <= -30) {
				direction, severity := "increased", "info"
				if *change < 0 {
					direction, severity = "decreased", "warning"
				}
				events = append(events, historyEvent{
					ID: "cost:" + date, OccurredAt: occurredAt, Kind: "cost_shift", Category: "cost",
					Classification: "fact", Severity: severity,
					Title:  fmt.Sprintf("Project cost %s %s", direction, formatDelta(*change)),
					Detail: "Daily credits compared with the previous day.",
					Evidence: []signalEvidence{{Label: "Credits", Value: workspaceRound(currentCost, 4), Unit: "credits"},
						{Label: "Previous day", Value: workspaceRound(previousCost, 4), Unit: "credits"}},
				})
			}
		}
	}
	return events
}

func (h *Handler) intelligenceHistory(w http.ResponseWriter, r *http.Request) {
	ictx, ok := h.workspaceResolve(w, r)
	if !ok {
		return
	}
	page, ok := workspaceIntQueryParam(w, r, "page", 1, 10000)
	if !ok {
		return
	}
	pageSize, ok := workspaceIntQueryParam(w, r, "page_size", 30, 100)
	if !ok {
		return
	}
	ctx := r.Context()
	now := time.Now().UTC()
	startTime := now.AddDate(0, 0, -ictx.days)
	events := []historyEvent{}
	registryStatus, registryMessage := "fresh", ""

	versionRows, versionErr := h.Store.DB.Query(ctx,
		`SELECT v.id::text, a.id::text, a.name, a.namespace, a.slug, v.version,
		        v.status::text, COALESCE(v.reviewed_at, v.created_at)
		 FROM agent_versions v JOIN agents a ON a.id = v.agent_id
		 WHERE a.project_id = $1 AND v.created_at >= $2
		 ORDER BY COALESCE(v.reviewed_at, v.created_at) DESC LIMIT 250`, ictx.project.ID, startTime)
	if versionErr != nil {
		registryStatus, registryMessage = "partial", "Version history is temporarily unavailable."
	} else {
		for versionRows.Next() {
			var agentID, versionID, name, namespace, slug, version, status string
			var occurredAt time.Time
			if err := versionRows.Scan(&versionID, &agentID, &name, &namespace, &slug, &version, &status, &occurredAt); err != nil {
				versionRows.Close()
				httpapi.WriteInternalError(w, r, err)
				return
			}
			qualified := namespace + "/" + slug
			event := historyEvent{
				ID: "version:" + versionID, OccurredAt: occurredAt.UTC().Format(time.RFC3339),
				Category: "change", Classification: "fact", Severity: "info", AgentID: &agentID,
				QualifiedName: &qualified, VersionID: &versionID, Version: &version,
				Evidence: []signalEvidence{{Label: "Version", Value: version, Unit: ""}},
			}
			switch status {
			case "approved":
				event.Kind, event.Title, event.Detail = "version_released", name+" released "+version, "The reviewed version became the active release."
			case "rejected":
				event.Kind, event.Title, event.Detail, event.Severity = "change_rejected", name+" change was rejected", "The version did not pass review.", "warning"
			case "pending":
				event.Kind, event.Title, event.Detail = "change_submitted", name+" submitted "+version, "A version entered review."
			default:
				continue
			}
			events = append(events, event)
		}
		versionRows.Close()
		if err := versionRows.Err(); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
	}

	issueRows, issueErr := h.Store.DB.Query(ctx,
		`SELECT i.id::text, a.id::text, a.name, a.namespace, a.slug, i.version_id::text,
		        i.title, 'issue_opened', i.created_at
		 FROM review_issues i JOIN agents a ON a.id = i.subject_id
		 WHERE i.subject_type = 'agent' AND a.project_id = $1 AND i.created_at >= $2
		 UNION ALL
		 SELECT i.id::text, a.id::text, a.name, a.namespace, a.slug, i.version_id::text,
		        i.title, 'issue_resolved', i.resolved_at
		 FROM review_issues i JOIN agents a ON a.id = i.subject_id
		 WHERE i.subject_type = 'agent' AND a.project_id = $1 AND i.resolved_at >= $2
		 ORDER BY 9 DESC LIMIT 250`, ictx.project.ID, startTime)
	if issueErr != nil {
		registryStatus = "partial"
		if registryMessage == "" {
			registryMessage = "Review-issue history is temporarily unavailable."
		} else {
			registryMessage = "Version and review-issue history are temporarily unavailable."
		}
	} else {
		for issueRows.Next() {
			var issueID, agentID, name, namespace, slug, title, kind string
			var versionID *string
			var occurredAt time.Time
			if err := issueRows.Scan(&issueID, &agentID, &name, &namespace, &slug, &versionID, &title, &kind, &occurredAt); err != nil {
				issueRows.Close()
				httpapi.WriteInternalError(w, r, err)
				return
			}
			qualified := namespace + "/" + slug
			event := historyEvent{
				ID:         kind + ":" + issueID + ":" + occurredAt.Format(time.RFC3339),
				OccurredAt: occurredAt.UTC().Format(time.RFC3339), Kind: kind, Category: "quality",
				Classification: "fact", AgentID: &agentID, QualifiedName: &qualified,
				VersionID: versionID, IssueID: &issueID,
				Evidence: []signalEvidence{{Label: "Issue", Value: title, Unit: ""}},
			}
			if kind == "issue_resolved" {
				event.Severity, event.Title, event.Detail = "info", name+" resolved an issue", title
			} else {
				event.Severity, event.Title, event.Detail = "warning", name+" received a review issue", title
			}
			events = append(events, event)
		}
		issueRows.Close()
		if err := issueRows.Err(); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
	}

	dailyRows, telemetryErr := h.queryWorkspaceRows(ctx, dailyActivitySQL, clickhouse.Settings{
		"param_pid": ictx.project.ID.String(), "param_days": strconv.Itoa(ictx.days),
	})
	if telemetryErr == nil {
		events = append(events, dailyShiftEvents(dailyRows, ictx.includeCost)...)
	}

	resourceFilter, categoryFilter := r.URL.Query().Get("resource"), r.URL.Query().Get("category")
	filtered := make([]historyEvent, 0, len(events))
	for _, event := range events {
		if resourceFilter != "" && (event.AgentID == nil || *event.AgentID != resourceFilter) {
			continue
		}
		if categoryFilter != "" && event.Category != categoryFilter {
			continue
		}
		filtered = append(filtered, event)
	}
	sort.SliceStable(filtered, func(left, right int) bool { return filtered[left].OccurredAt > filtered[right].OccurredAt })
	total := len(filtered)
	start := (page - 1) * pageSize
	if start > total {
		start = total
	}
	end := min(start+pageSize, total)
	sources := []workspaceSource{workspaceSourceState("registry", registryStatus, registryMessage, now)}
	if telemetryErr != nil {
		sources = append(sources, workspaceSourceState("telemetry", "unavailable", "Usage and cost shifts are temporarily unavailable.", now))
	} else {
		sources = append(sources, workspaceSourceState("telemetry", "fresh", "", now))
	}
	if !ictx.includeCost {
		sources = append(sources, workspaceSourceState("cost", "restricted", "Cost events require project administration access.", now))
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"range": ictx.rng, "generated_at": now.Format(time.RFC3339), "sources": sources,
		"events": filtered[start:end], "total": total, "page": page, "page_size": pageSize,
		"has_more": end < total,
	})
}
