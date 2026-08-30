// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package insights serves the report reads and deletions for agent
// insight reports; generation, export, and suggestion application are
// answered by the insights engine service.
package insights

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// PGQuerier is the subset of a pgx pool the store needs.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// CHQuerier runs analytics-store reads.
type CHQuerier interface {
	QueryJSON(ctx context.Context, sql string, settings clickhouse.Settings) ([]map[string]any, error)
}

// Store carries the insights data dependencies.
type Store struct {
	DB PGQuerier
	CH CHQuerier
}

// legacyUnversioned matches telemetry ingested before versions existed;
// those rows belong to the first published version.
const legacyUnversioned = "1.0.0"

// versionFilter renders the version-scoped telemetry predicate.
func versionFilter(column string, nullable bool) string {
	expr := column
	if nullable {
		expr = "coalesce(" + column + ", '')"
	}
	return "({agent_version:String} = '' OR " + expr + " = {agent_version:String} " +
		"OR ({agent_version:String} = '" + legacyUnversioned + "' AND " + expr + " = ''))"
}

// ApprovedVersion resolves the requested approved version, or the latest
// one when no version is requested. A nil result means not found.
func (s *Store) ApprovedVersion(ctx context.Context, agentID string, requested string) (id, version string, err error) {
	sql := `SELECT id::text, version FROM agent_versions
		WHERE agent_id = $1 AND status = 'approved'`
	args := []any{agentID}
	if requested != "" {
		sql += ` AND version = $2`
		args = append(args, requested)
	} else {
		sql += ` ORDER BY released_at DESC NULLS LAST, created_at DESC`
	}
	sql += ` LIMIT 1`
	err = s.DB.QueryRow(ctx, sql, args...).Scan(&id, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	return id, version, err
}

// SessionCount counts sessions for the agent in the period, scoped to the
// telemetry version. The aggregate table is preferred; older deployments
// fall back to distinct sessions over raw events.
func (s *Store) SessionCount(ctx context.Context, agentID, agentName string, start, end time.Time, version string) int64 {
	projectID, ok := tenancy.ProjectIDFromContext(ctx)
	if !ok {
		return 0
	}
	settings := clickhouse.Settings{
		"param_agent_id":   agentID,
		"param_agent_name": agentName,
		"param_project_id": projectID,
		"param_t_start":    start.UTC().Format("2006-01-02 15:04:05"),
		"param_t_end":      end.UTC().Format("2006-01-02 15:04:05"),
	}
	where := "WHERE project_id = {project_id:String} " +
		"AND (agent_id = {agent_id:String} OR agent_id = {agent_name:String}) " +
		"AND last_event_time >= {t_start:String} AND last_event_time <= {t_end:String} "
	if version != "" {
		settings["param_agent_version"] = version
		where += "AND " + versionFilter("agent_version", false) + " "
	}
	rows, err := s.CH.QueryJSON(ctx,
		"SELECT count() AS cnt FROM session_stats_agg FINAL "+where+"FORMAT JSON", settings)
	if err == nil && len(rows) > 0 {
		return chInt(rows[0], "cnt")
	}

	fallback := "WHERE project_id = {project_id:String} " +
		"AND (agent_id = {agent_id:String} OR agent_id = {agent_name:String}) " +
		"AND timestamp >= {t_start:String} AND timestamp <= {t_end:String} "
	if version != "" {
		fallback += "AND " + versionFilter("agent_version", true) + " "
	}
	rows, err = s.CH.QueryJSON(ctx,
		"SELECT count(DISTINCT session_id) AS cnt FROM session_events FINAL "+fallback+"FORMAT JSON", settings)
	if err == nil && len(rows) > 0 {
		return chInt(rows[0], "cnt")
	}
	return 0
}

func chInt(row map[string]any, key string) int64 {
	switch v := row[key].(type) {
	case string:
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	case float64:
		return int64(v)
	}
	return 0
}

// reportColumns are shared by the list and detail reads.
const reportColumns = `id::text, agent_id::text, agent_version_id::text, agent_version,
	version_scope, comparison_agent_version_id::text, comparison_agent_version,
	triggered_by::text, status::text, period_start, period_end,
	metrics, narrative, sessions_analyzed, llm_model_used, error_message,
	started_at, completed_at, created_at, previous_report_id::text,
	aggregated_data, report_version, applied_at, applied_items,
	progress_phase, progress_current, progress_total, progress_percent,
	progress_message, progress_updated_at`

// Report is one insight report row.
type Report struct {
	ID                       string
	AgentID                  string
	AgentVersionID           *string
	AgentVersion             *string
	VersionScope             *string
	ComparisonAgentVersionID *string
	ComparisonAgentVersion   *string
	TriggeredBy              *string
	Status                   string
	PeriodStart              time.Time
	PeriodEnd                time.Time
	Metrics                  any
	Narrative                any
	SessionsAnalyzed         int
	LLMModelUsed             *string
	ErrorMessage             *string
	StartedAt                time.Time
	CompletedAt              *time.Time
	CreatedAt                time.Time
	PreviousReportID         *string
	AggregatedData           any
	ReportVersion            int
	AppliedAt                *time.Time
	AppliedItems             any
	ProgressPhase            *string
	ProgressCurrent          int
	ProgressTotal            int
	ProgressPercent          int
	ProgressMessage          *string
	ProgressUpdatedAt        *time.Time
}

func scanReport(row pgx.Row) (*Report, error) {
	var rep Report
	err := row.Scan(
		&rep.ID, &rep.AgentID, &rep.AgentVersionID, &rep.AgentVersion,
		&rep.VersionScope, &rep.ComparisonAgentVersionID, &rep.ComparisonAgentVersion,
		&rep.TriggeredBy, &rep.Status, &rep.PeriodStart, &rep.PeriodEnd,
		&rep.Metrics, &rep.Narrative, &rep.SessionsAnalyzed, &rep.LLMModelUsed, &rep.ErrorMessage,
		&rep.StartedAt, &rep.CompletedAt, &rep.CreatedAt, &rep.PreviousReportID,
		&rep.AggregatedData, &rep.ReportVersion, &rep.AppliedAt, &rep.AppliedItems,
		&rep.ProgressPhase, &rep.ProgressCurrent, &rep.ProgressTotal, &rep.ProgressPercent,
		&rep.ProgressMessage, &rep.ProgressUpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &rep, nil
}

// listColumns skips the LLM payload blobs the list wire form never renders.
const listColumns = `id::text, agent_id::text, agent_version_id::text, agent_version,
	version_scope, status::text, period_start, period_end, sessions_analyzed,
	created_at, completed_at, progress_phase, progress_current, progress_total,
	progress_percent, progress_message, progress_updated_at`

// ListReports returns the newest twenty reports for an agent.
func (s *Store) ListReports(ctx context.Context, agentID string) ([]*Report, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT `+listColumns+` FROM insight_reports
		 WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	reports := []*Report{}
	for rows.Next() {
		var rep Report
		if err := rows.Scan(
			&rep.ID, &rep.AgentID, &rep.AgentVersionID, &rep.AgentVersion,
			&rep.VersionScope, &rep.Status, &rep.PeriodStart, &rep.PeriodEnd, &rep.SessionsAnalyzed,
			&rep.CreatedAt, &rep.CompletedAt, &rep.ProgressPhase, &rep.ProgressCurrent, &rep.ProgressTotal,
			&rep.ProgressPercent, &rep.ProgressMessage, &rep.ProgressUpdatedAt,
		); err != nil {
			return nil, err
		}
		reports = append(reports, &rep)
	}
	return reports, rows.Err()
}

// GetReport returns one report; nil when absent or the id is malformed.
func (s *Store) GetReport(ctx context.Context, reportID string) (*Report, error) {
	rep, err := scanReport(s.DB.QueryRow(ctx,
		`SELECT `+reportColumns+` FROM insight_reports WHERE id = $1`, reportID))
	if err != nil && isInvalidUUID(err) {
		return nil, nil
	}
	return rep, err
}

// isInvalidUUID matches the id-syntax error a malformed report id raises.
func isInvalidUUID(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "22P02"
}

// DeleteCounts reports what a per-agent purge removed.
type DeleteCounts struct {
	Reports int64
	Facets  int64
	Cache   int64
}

// DeleteAgentReports removes all reports and cached insight data.
func (s *Store) DeleteAgentReports(ctx context.Context, agentID string) (DeleteCounts, error) {
	var counts DeleteCounts
	tag, err := s.DB.Exec(ctx, `DELETE FROM insight_reports WHERE agent_id = $1`, agentID)
	if err != nil {
		return counts, err
	}
	counts.Reports = tag.RowsAffected()
	tag, err = s.DB.Exec(ctx, `DELETE FROM insight_session_facets WHERE agent_id = $1`, agentID)
	if err != nil {
		return counts, err
	}
	counts.Facets = tag.RowsAffected()
	tag, err = s.DB.Exec(ctx, `DELETE FROM insight_meta_cache WHERE agent_id = $1`, agentID)
	if err != nil {
		return counts, err
	}
	counts.Cache = tag.RowsAffected()
	return counts, nil
}

// DeleteReport removes one report.
func (s *Store) DeleteReport(ctx context.Context, reportID string) error {
	_, err := s.DB.Exec(ctx, `DELETE FROM insight_reports WHERE id = $1`, reportID)
	return err
}
