// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package overview serves the platform overview analytics: catalog and
// user counts, download leaders, and submission trends.
package overview

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// PGQuerier is the subset of a pgx pool these reads need.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// CHQuerier runs ClickHouse FORMAT JSON statements with bound parameters.
type CHQuerier interface {
	QueryJSON(ctx context.Context, sql string, settings clickhouse.Settings) ([]map[string]any, error)
}

// Viewer is the authenticated principal, or nil for anonymous callers.
type Viewer struct {
	ID   uuid.UUID
	Role string
}

// visibilityClause renders the private-listing row filter for a table whose
// creator column is given.
func visibilityClause(alias, creatorColumn string, viewer *Viewer, args *[]any) string {
	public := fmt.Sprintf("%s.is_private = FALSE", alias)
	if viewer == nil {
		return public
	}
	*args = append(*args, viewer.ID)
	arg := fmt.Sprintf("$%d", len(*args))
	own := fmt.Sprintf(
		"(%s.is_private = TRUE AND (%s.ownership_scope = 'private' OR %s.project_id IS NULL) AND %s = %s)",
		alias, alias, alias, creatorColumn, arg)
	projectMember := fmt.Sprintf(
		"(%s.is_private = TRUE AND %s.project_id IS NOT NULL AND %s.ownership_scope != 'private' AND EXISTS ("+
			"SELECT 1 FROM project_memberships pm WHERE pm.project_id = %s.project_id AND pm.user_id = %s))",
		alias, alias, alias, alias, arg)
	return "(" + public + " OR " + own + " OR " + projectMember + ")"
}

// Store answers the overview queries.
type Store struct {
	DB PGQuerier
	CH CHQuerier
}

// Stats carries the headline counters.
type Stats struct {
	TotalMcps              int64
	TotalAgents            int64
	TotalUsers             int64
	TotalToolCalls         int64
	TotalAgentInteractions int64
}

// chNumber normalizes the analytics store's string-quoted 64-bit integers;
// analytics-store failures degrade to zero so the relational counters
// still render.
func chNumber(v any) int64 {
	switch n := v.(type) {
	case string:
		parsed, _ := strconv.ParseInt(n, 10, 64)
		return parsed
	case float64:
		return int64(n)
	}
	return 0
}

// Stats aggregates catalog counts (visibility-scoped) and usage counters.
func (s *Store) Stats(ctx context.Context, days int, viewer *Viewer) (Stats, error) {
	out := Stats{}

	// One statement answers all three counters; the shared args slice keeps
	// the visibility placeholders numbered across both clauses.
	args := []any{}
	mcpWhere := visibilityClause("l", "l.submitted_by", viewer, &args)
	agentWhere := visibilityClause("a", "a.created_by", viewer, &args)
	if err := s.DB.QueryRow(ctx, fmt.Sprintf(
		`SELECT
		 (SELECT count(l.id) FROM mcp_listings l
		  JOIN mcp_versions v ON l.latest_version_id = v.id
		  WHERE v.status = 'approved' AND %s),
		 (SELECT count(a.id) FROM agents a
		  JOIN agent_versions v ON a.latest_version_id = v.id
		  WHERE v.status = 'approved' AND a.deleted_at IS NULL AND %s),
		 (SELECT count(id) FROM users)`, mcpWhere, agentWhere), args...).
		Scan(&out.TotalMcps, &out.TotalAgents, &out.TotalUsers); err != nil {
		return out, err
	}

	// Both analytics counters share the predicate, so one scan serves both.
	rows, err := s.CH.QueryJSON(ctx,
		"SELECT sum(tool_call_count) AS calls, count() AS sessions FROM session_stats_agg FINAL"+
			" WHERE last_event_time > now() - INTERVAL {days:UInt32} DAY"+
			" SETTINGS do_not_merge_across_partitions_select_final = 1 FORMAT JSON",
		clickhouse.Settings{"param_days": fmt.Sprintf("%d", days)})
	if err == nil && len(rows) > 0 {
		out.TotalToolCalls = chNumber(rows[0]["calls"])
		out.TotalAgentInteractions = chNumber(rows[0]["sessions"])
	}
	return out, nil
}

// TopItem is one download leader.
type TopItem struct {
	ID    string
	Name  string
	Count int64
}

// TopMcps returns the five most-downloaded visible listings.
func (s *Store) TopMcps(ctx context.Context, viewer *Viewer) ([]TopItem, error) {
	args := []any{}
	where := visibilityClause("l", "l.submitted_by", viewer, &args)
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT d.listing_id::text, count(d.id) AS cnt, l.name
		 FROM mcp_downloads d JOIN mcp_listings l ON d.listing_id = l.id
		 WHERE %s
		 GROUP BY d.listing_id, l.name
		 ORDER BY count(d.id) DESC LIMIT 5`, where), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopItem{}
	for rows.Next() {
		var it TopItem
		if err := rows.Scan(&it.ID, &it.Count, &it.Name); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// TopAgent is one agent download leader with its latest release metadata.
type TopAgent struct {
	ID            string
	Name          string
	Namespace     string
	Slug          string
	Description   *string
	Owner         *string
	Version       *string
	DownloadCount int64
}

// TopAgents returns the most-installed visible agents.
func (s *Store) TopAgents(ctx context.Context, limit int, viewer *Viewer) ([]TopAgent, error) {
	args := []any{}
	where := visibilityClause("a", "a.created_by", viewer, &args)
	args = append(args, limit)
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT d.agent_id::text, count(d.id) AS cnt, a.name, a.namespace, a.slug,
		        v.description, a.owner, v.version
		 FROM agent_download_records d
		 JOIN agents a ON d.agent_id = a.id
		 JOIN agent_versions v ON a.latest_version_id = v.id
		 WHERE v.status = 'approved' AND a.deleted_at IS NULL AND %s
		 GROUP BY d.agent_id, a.name, a.namespace, a.slug, v.description, a.owner, v.version
		 ORDER BY count(d.id) DESC LIMIT $%d`, where, len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopAgent{}
	for rows.Next() {
		var a TopAgent
		if err := rows.Scan(&a.ID, &a.DownloadCount, &a.Name, &a.Namespace, &a.Slug,
			&a.Description, &a.Owner, &a.Version); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// TrendPoint is one day's submissions and signups.
type TrendPoint struct {
	Date        string
	Submissions int64
	Users       int64
}

// Trends buckets listing submissions and user signups per day.
func (s *Store) Trends(ctx context.Context, days int, now time.Time) ([]TrendPoint, error) {
	start := now.UTC().AddDate(0, 0, -days)
	collect := func(table string) (map[string]int64, error) {
		rows, err := s.DB.Query(ctx, fmt.Sprintf(
			`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD'), count(id)
			 FROM %s WHERE created_at >= $1
			 GROUP BY 1 ORDER BY 1`, table), start)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		m := map[string]int64{}
		for rows.Next() {
			var day string
			var cnt int64
			if err := rows.Scan(&day, &cnt); err != nil {
				return nil, err
			}
			m[day] = cnt
		}
		return m, rows.Err()
	}
	submissions, err := collect("mcp_listings")
	if err != nil {
		return nil, err
	}
	users, err := collect("users")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	dates := []string{}
	for d := range submissions {
		if !seen[d] {
			seen[d] = true
			dates = append(dates, d)
		}
	}
	for d := range users {
		if !seen[d] {
			seen[d] = true
			dates = append(dates, d)
		}
	}
	sortStrings(dates)
	out := make([]TrendPoint, 0, len(dates))
	for _, d := range dates {
		out = append(out, TrendPoint{Date: d, Submissions: submissions[d], Users: users[d]})
	}
	return out, nil
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
