// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insights

import "time"

// wireTime renders UTC timestamps with six microsecond digits, or none
// when the sub-second part is zero.
func wireTime(t time.Time) string {
	t = t.UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05Z")
	}
	return t.Format("2006-01-02T15:04:05.000000Z")
}

func wireTimePtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return wireTime(*t)
}

func strOrNil(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// ListItem is the summary wire form of a report.
func (r *Report) ListItem() map[string]any {
	return map[string]any{
		"id":                  r.ID,
		"agent_id":            r.AgentID,
		"agent_version_id":    strOrNil(r.AgentVersionID),
		"agent_version":       strOrNil(r.AgentVersion),
		"version_scope":       strOrNil(r.VersionScope),
		"status":              r.Status,
		"period_start":        wireTime(r.PeriodStart),
		"period_end":          wireTime(r.PeriodEnd),
		"sessions_analyzed":   r.SessionsAnalyzed,
		"created_at":          wireTime(r.CreatedAt),
		"completed_at":        wireTimePtr(r.CompletedAt),
		"progress_phase":      strOrNil(r.ProgressPhase),
		"progress_current":    r.ProgressCurrent,
		"progress_total":      r.ProgressTotal,
		"progress_percent":    r.ProgressPercent,
		"progress_message":    strOrNil(r.ProgressMessage),
		"progress_updated_at": wireTimePtr(r.ProgressUpdatedAt),
	}
}

// Detail is the full wire form of a report.
func (r *Report) Detail() map[string]any {
	return map[string]any{
		"id":                          r.ID,
		"agent_id":                    r.AgentID,
		"agent_version_id":            strOrNil(r.AgentVersionID),
		"agent_version":               strOrNil(r.AgentVersion),
		"version_scope":               strOrNil(r.VersionScope),
		"comparison_agent_version_id": strOrNil(r.ComparisonAgentVersionID),
		"comparison_agent_version":    strOrNil(r.ComparisonAgentVersion),
		"triggered_by":                strOrNil(r.TriggeredBy),
		"status":                      r.Status,
		"period_start":                wireTime(r.PeriodStart),
		"period_end":                  wireTime(r.PeriodEnd),
		"metrics":                     r.Metrics,
		"narrative":                   r.Narrative,
		"sessions_analyzed":           r.SessionsAnalyzed,
		"llm_model_used":              strOrNil(r.LLMModelUsed),
		"error_message":               strOrNil(r.ErrorMessage),
		"started_at":                  wireTime(r.StartedAt),
		"completed_at":                wireTimePtr(r.CompletedAt),
		"created_at":                  wireTime(r.CreatedAt),
		"progress_phase":              strOrNil(r.ProgressPhase),
		"progress_current":            r.ProgressCurrent,
		"progress_total":              r.ProgressTotal,
		"progress_percent":            r.ProgressPercent,
		"progress_message":            strOrNil(r.ProgressMessage),
		"progress_updated_at":         wireTimePtr(r.ProgressUpdatedAt),
		"previous_report_id":          strOrNil(r.PreviousReportID),
		"aggregated_data":             r.AggregatedData,
		"report_version":              r.ReportVersion,
		"applied_at":                  wireTimePtr(r.AppliedAt),
		"applied_items":               r.AppliedItems,
	}
}
