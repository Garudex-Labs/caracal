// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package execdash serves the executive dashboard analytics for
// deployment administrators.
package execdash

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// DefaultProjectID scopes analytics rows during the single-project phase.
const DefaultProjectID = "default"

// PGQuerier is the subset of a pgx pool these queries need.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// CHQuerier runs ClickHouse FORMAT JSON statements.
type CHQuerier interface {
	QueryJSON(ctx context.Context, sql string, settings clickhouse.Settings) ([]map[string]any, error)
}

// Store answers the executive dashboard queries.
type Store struct {
	DB PGQuerier
	CH CHQuerier
}

// chJSON runs an analytics query with the project scope substituted and
// partition-independent FINAL processing; failures degrade to no rows.
func (s *Store) chJSON(ctx context.Context, sql string, settings clickhouse.Settings) []map[string]any {
	sql = replaceProjectScope(sql)
	if containsFINAL(sql) && !containsSETTINGS(sql) {
		sql += " SETTINGS do_not_merge_across_partitions_select_final = 1"
	}
	rows, err := s.CH.QueryJSON(ctx, sql+" FORMAT JSON", settings)
	if err != nil {
		return nil
	}
	return rows
}

func replaceProjectScope(sql string) string {
	const marker = "project_id = '{project_id}'"
	out := ""
	for {
		i := indexOf(sql, marker)
		if i < 0 {
			return out + sql
		}
		out += sql[:i] + "project_id = '" + DefaultProjectID + "'"
		sql = sql[i+len(marker):]
	}
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func containsFINAL(s string) bool    { return indexOf(s, "FINAL") >= 0 }
func containsSETTINGS(s string) bool { return indexOf(s, "SETTINGS") >= 0 }

// chInt reads one integer column that ClickHouse may quote.
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

// round1 rounds half-to-even to one decimal, matching the wire producer.
func round1(f float64) float64 { return math.RoundToEven(f*10) / 10 }

// Config is the executive dashboard configuration row.
type Config struct {
	ID                 uuid.UUID
	HourlyDevCost      float64
	PreAIBaselines     map[string]any
	DepartmentBudgets  map[string]any
	TargetAdoptionPct  int64
	TargetAdoptionDate *string
}

// GetConfig returns the singleton configuration, or nil when absent.
func (s *Store) GetConfig(ctx context.Context) (*Config, error) {
	row := s.DB.QueryRow(ctx,
		`SELECT id, hourly_dev_cost::float8, pre_ai_baselines, department_budgets,
		 target_adoption_pct, target_adoption_date::text
		 FROM exec_dashboard_config LIMIT 1`)
	cfg := &Config{}
	err := row.Scan(&cfg.ID, &cfg.HourlyDevCost, &cfg.PreAIBaselines, &cfg.DepartmentBudgets,
		&cfg.TargetAdoptionPct, &cfg.TargetAdoptionDate)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return cfg, nil
}

// ConfigUpdate carries the partial configuration update.
type ConfigUpdate struct {
	HourlyDevCost      *float64
	PreAIBaselines     map[string]any
	DepartmentBudgets  map[string]any
	TargetAdoptionPct  *int64
	TargetAdoptionDate *string
}

// UpdateConfig creates or partially updates the singleton row.
func (s *Store) UpdateConfig(ctx context.Context, u ConfigUpdate) (*Config, error) {
	existing, err := s.GetConfig(ctx)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		id := uuid.New()
		if _, err := s.DB.Exec(ctx,
			`INSERT INTO exec_dashboard_config
			 (id, hourly_dev_cost, pre_ai_baselines, department_budgets, target_adoption_pct, created_at, updated_at)
			 VALUES ($1, 75.00, '{}', '{}', 100, now(), now())`, id); err != nil {
			return nil, err
		}
	}
	sets := []string{"updated_at = now()"}
	args := []any{}
	bind := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if u.HourlyDevCost != nil {
		sets = append(sets, "hourly_dev_cost = "+bind(*u.HourlyDevCost))
	}
	if u.PreAIBaselines != nil {
		sets = append(sets, "pre_ai_baselines = "+bind(u.PreAIBaselines))
	}
	if u.DepartmentBudgets != nil {
		sets = append(sets, "department_budgets = "+bind(u.DepartmentBudgets))
	}
	if u.TargetAdoptionPct != nil {
		sets = append(sets, "target_adoption_pct = "+bind(*u.TargetAdoptionPct))
	}
	if u.TargetAdoptionDate != nil {
		if _, err := time.Parse("2006-01-02", *u.TargetAdoptionDate); err != nil {
			return nil, fmt.Errorf("invalid target adoption date: %w", err)
		}
		sets = append(sets, "target_adoption_date = "+bind(*u.TargetAdoptionDate))
	}
	set := sets[0]
	for _, s := range sets[1:] {
		set += ", " + s
	}
	if _, err := s.DB.Exec(ctx, "UPDATE exec_dashboard_config SET "+set, args...); err != nil {
		return nil, err
	}
	return s.GetConfig(ctx)
}

// AdoptionPoint is one month's adoption percentage.
type AdoptionPoint struct {
	Month string
	Pct   float64
}

// Adoption carries the adoption tab payload.
type Adoption struct {
	Monthly            []AdoptionPoint
	CurrentPct         float64
	TotalUsers         int64
	ActiveUsers        int64
	DepartmentsCovered int64
}

// Adoption aggregates monthly active users against the deployment size.
func (s *Store) Adoption(ctx context.Context) (Adoption, error) {
	out := Adoption{Monthly: []AdoptionPoint{}}
	if err := s.DB.QueryRow(ctx, "SELECT count(id) FROM users").Scan(&out.TotalUsers); err != nil {
		return out, err
	}
	rows := s.chJSON(ctx,
		"SELECT toStartOfMonth(first_event_time) AS month, "+
			"count(DISTINCT user_id) AS active "+
			"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL 12 MONTH "+
			"GROUP BY month ORDER BY month", nil)
	for _, r := range rows {
		active := chInt(r, "active")
		pct := 0.0
		if out.TotalUsers > 0 {
			pct = round1(float64(active) / float64(out.TotalUsers) * 100)
		}
		month, _ := r["month"].(string)
		if len(month) > 7 {
			month = month[:7]
		}
		out.Monthly = append(out.Monthly, AdoptionPoint{Month: month, Pct: pct})
	}
	current := s.chJSON(ctx,
		"SELECT count(DISTINCT user_id) AS active "+
			"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
			"AND first_event_time >= toStartOfMonth(now())", nil)
	if len(current) > 0 {
		out.ActiveUsers = chInt(current[0], "active")
	}
	if out.TotalUsers > 0 {
		out.CurrentPct = round1(float64(out.ActiveUsers) / float64(out.TotalUsers) * 100)
	}
	departments, err := s.departmentCount(ctx)
	if err != nil {
		return out, err
	}
	out.DepartmentsCovered = departments
	return out, nil
}

// departmentCount mirrors the department mapping and counts every named
// department, excluding the synthetic unassigned bucket.
func (s *Store) departmentCount(ctx context.Context) (int64, error) {
	names := map[string]bool{}
	groupRows, err := s.DB.Query(ctx, "SELECT DISTINCT group_name FROM user_groups")
	if err != nil {
		return 0, err
	}
	for groupRows.Next() {
		var name string
		if err := groupRows.Scan(&name); err != nil {
			groupRows.Close()
			return 0, err
		}
		names[name] = true
	}
	groupRows.Close()
	if err := groupRows.Err(); err != nil {
		return 0, err
	}
	// Department-attributed users who are not in any group.
	deptRows, err := s.DB.Query(ctx,
		`SELECT DISTINCT department FROM users
		 WHERE department IS NOT NULL
		 AND id NOT IN (SELECT user_id FROM user_groups)`)
	if err != nil {
		return 0, err
	}
	defer deptRows.Close()
	for deptRows.Next() {
		var name string
		if err := deptRows.Scan(&name); err != nil {
			return 0, err
		}
		names[name] = true
	}
	return int64(len(names)), deptRows.Err()
}

// AgentCounts is the agent status and category breakdown.
type AgentCounts struct {
	Total         int64
	Active        int64
	Published     int64
	InDevelopment int64
	ByCategory    []map[string]any
}

// AgentCounts aggregates catalog totals and recent activity.
func (s *Store) AgentCounts(ctx context.Context) (AgentCounts, error) {
	out := AgentCounts{ByCategory: []map[string]any{}}
	if err := s.DB.QueryRow(ctx, "SELECT count(*) FROM agents").Scan(&out.Total); err != nil {
		return out, err
	}
	if err := s.DB.QueryRow(ctx,
		`SELECT count(a.id) FROM agents a
		 JOIN agent_versions v ON a.latest_version_id = v.id
		 WHERE v.status = 'approved'`).Scan(&out.Published); err != nil {
		return out, err
	}
	if err := s.DB.QueryRow(ctx,
		`SELECT count(a.id) FROM agents a
		 JOIN agent_versions v ON a.latest_version_id = v.id
		 WHERE v.status IN ('pending', 'draft')`).Scan(&out.InDevelopment); err != nil {
		return out, err
	}
	active := s.chJSON(ctx,
		"SELECT count(DISTINCT agent_id) AS cnt FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' AND agent_id != '' "+
			"AND first_event_time >= now() - INTERVAL 7 DAY", nil)
	if len(active) > 0 {
		out.Active = chInt(active[0], "cnt")
	}
	rows, err := s.DB.Query(ctx, "SELECT category, count(id) FROM agents GROUP BY category")
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var category *string
		var count int64
		if err := rows.Scan(&category, &count); err != nil {
			return out, err
		}
		name := "Uncategorized"
		if category != nil && *category != "" {
			name = *category
		}
		out.ByCategory = append(out.ByCategory, map[string]any{"category": name, "count": count})
	}
	return out, rows.Err()
}
