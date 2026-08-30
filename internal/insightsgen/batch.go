// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"log/slog"
	"time"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// batchAgent is one discovery candidate: an agent whose latest version is
// approved.
type batchAgent struct {
	ID              string
	Name            string
	LatestVersionID string
	LatestVersion   string
}

// countAgentSessions counts sessions for an agent version since the cutoff,
// preferring the aggregate table.
func (e *Engine) countAgentSessions(ctx context.Context, agentID, agentName, since, agentVersion string) int64 {
	params := clickhouse.Settings{
		"param_agent_id":      agentID,
		"param_aname":         agentName,
		"param_t_start":       since,
		"param_agent_version": agentVersion,
	}
	rows, err := e.CH.QueryJSON(ctx, `
		SELECT count() AS cnt
		FROM session_stats_agg FINAL
		WHERE (agent_id = {agent_id:String} OR agent_id = {aname:String})
		  AND last_event_time >= {t_start:String}
		  AND `+versionFilter("agent_version", false)+`
		FORMAT JSON`, params)
	if err == nil && len(rows) > 0 {
		return int64(chFloat(rows[0], "cnt"))
	}
	if err != nil {
		slog.Warn("batch session count aggregate failed", "agent", agentName, "error", err)
	}
	rows, err = e.CH.QueryJSON(ctx, `
		SELECT count(DISTINCT session_id) AS cnt
		FROM session_events FINAL
		WHERE (agent_id = {agent_id:String} OR agent_id = {aname:String})
		  AND timestamp >= {t_start:String}
		  AND `+versionFilter("agent_version", true)+`
		FORMAT JSON`, params)
	if err != nil {
		slog.Warn("batch session count fallback failed", "agent", agentName, "error", err)
		return 0
	}
	if len(rows) == 0 {
		return 0
	}
	return int64(chFloat(rows[0], "cnt"))
}

// DiscoverAndQueue finds agents with enough new sessions and creates
// pending report rows for them. Returns the number of reports queued.
func (s *Service) DiscoverAndQueue(ctx context.Context) (int, error) {
	if reaped, err := s.Store.ReapStale(ctx); err != nil {
		slog.Warn("stale report reap failed", "error", err)
	} else if reaped > 0 {
		slog.Info("stale reports reaped before batch", "count", reaped)
	}

	cfg := s.Engine.Config
	if !cfg.Bool(ctx, "insights.batch_enabled", true) {
		return 0, nil
	}
	periodDays := cfg.Int(ctx, "insights.batch_period_days", 14)
	minSessions := cfg.Int(ctx, "insights.min_sessions", 5)
	now := time.Now().UTC()
	periodStart := now.AddDate(0, 0, -periodDays)

	agents, err := s.batchAgents(ctx)
	if err != nil {
		return 0, err
	}
	if len(agents) == 0 {
		slog.Debug("batch discovery found no agents")
		return 0, nil
	}

	queued := 0
	for _, agent := range agents {
		if ctx.Err() != nil {
			return queued, ctx.Err()
		}
		created, err := s.queueAgentReport(ctx, agent, periodStart, now, minSessions)
		if err != nil {
			slog.Error("batch discovery agent failed", "agent", agent.Name, "error", err)
			continue
		}
		if created {
			queued++
		}
	}
	slog.Info("batch discovery complete", "queued", queued, "agents_checked", len(agents))
	if queued > 0 {
		s.Enqueue()
	}
	return queued, nil
}

// batchAgents lists live agents whose latest version is approved; that is
// the population the discovery sweep considers.
func (s *Service) batchAgents(ctx context.Context) ([]batchAgent, error) {
	rows, err := s.Store.DB.Query(ctx, `
		SELECT a.id::text, a.name, v.id::text, v.version
		FROM agents a
		JOIN agent_versions v ON a.latest_version_id = v.id
		WHERE a.deleted_at IS NULL AND v.status = 'approved'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	agents := []batchAgent{}
	for rows.Next() {
		var a batchAgent
		if err := rows.Scan(&a.ID, &a.Name, &a.LatestVersionID, &a.LatestVersion); err != nil {
			return nil, err
		}
		agents = append(agents, a)
	}
	return agents, rows.Err()
}

// queueAgentReport applies the per-agent batch rules and creates the
// pending report row when they pass.
func (s *Service) queueAgentReport(ctx context.Context, agent batchAgent, periodStart, now time.Time, minSessions int) (bool, error) {
	// Skip when a report was already produced or is in flight within the
	// period.
	var recent int
	err := s.Store.DB.QueryRow(ctx, `
		SELECT count(*) FROM insight_reports
		WHERE agent_id = $1
		  AND status IN ('completed', 'running', 'pending')
		  AND created_at > $2`, agent.ID, periodStart).Scan(&recent)
	if err != nil {
		return false, err
	}
	if recent > 0 {
		return false, nil
	}

	sinceStr := periodStart.Format("2006-01-02 15:04:05")
	sessionCount := s.Engine.countAgentSessions(ctx, agent.ID, agent.Name, sinceStr, agent.LatestVersion)
	if sessionCount < int64(minSessions) {
		slog.Debug("batch discovery skipped agent",
			"agent", agent.Name, "sessions", sessionCount, "min_required", minSessions)
		return false, nil
	}

	// Most recent completed report for the same version, for regression
	// linking.
	var previousReportID *string
	var prevID string
	err = s.Store.DB.QueryRow(ctx, `
		SELECT id::text FROM insight_reports
		WHERE agent_id = $1 AND agent_version = $2 AND status = 'completed'
		ORDER BY created_at DESC LIMIT 1`, agent.ID, agent.LatestVersion).Scan(&prevID)
	if err == nil {
		previousReportID = &prevID
	}

	var reportID string
	err = s.Store.DB.QueryRow(ctx, `
		INSERT INTO insight_reports (
			id, agent_id, triggered_by, status, period_start, period_end,
			started_at, created_at, previous_report_id,
			agent_version_id, agent_version, version_scope,
			sessions_analyzed, report_version,
			progress_phase, progress_current, progress_total, progress_percent,
			progress_message, progress_updated_at)
		VALUES (gen_random_uuid(), $1, NULL, 'pending', $2, $3, $3, $3, $4,
		        $5, $6, 'canonical_and_dirty', 0, 1,
		        'queued', 0, 0, 0, 'Queued by scheduled insights batch', $3)
		RETURNING id::text`,
		agent.ID, periodStart, now, previousReportID,
		agent.LatestVersionID, agent.LatestVersion).Scan(&reportID)
	if err != nil {
		return false, err
	}
	slog.Info("batch discovery queued report",
		"agent", agent.Name, "agent_id", agent.ID, "report_id", reportID, "sessions", sessionCount)
	return true, nil
}
