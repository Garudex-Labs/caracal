// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package execdash

import (
	"context"
	"sort"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// departments returns the deployment's department → user-id mapping: named
// groups first, then department-attributed users outside any group, then
// the synthetic unassigned bucket.
func (s *Store) departments(ctx context.Context) (map[string][]string, error) {
	deptMap := map[string][]string{}
	assigned := map[string]bool{}

	groupRows, err := s.DB.Query(ctx, "SELECT group_name, user_id::text FROM user_groups")
	if err != nil {
		return nil, err
	}
	for groupRows.Next() {
		var name, uid string
		if err := groupRows.Scan(&name, &uid); err != nil {
			groupRows.Close()
			return nil, err
		}
		deptMap[name] = append(deptMap[name], uid)
		assigned[uid] = true
	}
	groupRows.Close()
	if err := groupRows.Err(); err != nil {
		return nil, err
	}

	deptRows, err := s.DB.Query(ctx,
		`SELECT id::text, department FROM users
		 WHERE department IS NOT NULL
		 AND id NOT IN (SELECT user_id FROM user_groups)`)
	if err != nil {
		return nil, err
	}
	for deptRows.Next() {
		var uid, dept string
		if err := deptRows.Scan(&uid, &dept); err != nil {
			deptRows.Close()
			return nil, err
		}
		deptMap[dept] = append(deptMap[dept], uid)
		assigned[uid] = true
	}
	deptRows.Close()
	if err := deptRows.Err(); err != nil {
		return nil, err
	}

	allRows, err := s.DB.Query(ctx, "SELECT id::text FROM users")
	if err != nil {
		return nil, err
	}
	defer allRows.Close()
	for allRows.Next() {
		var uid string
		if err := allRows.Scan(&uid); err != nil {
			return nil, err
		}
		if !assigned[uid] {
			deptMap["Unassigned"] = append(deptMap["Unassigned"], uid)
		}
	}
	return deptMap, allRows.Err()
}

func sortedKeys(m map[string][]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Department is one department's activity summary.
type Department struct {
	Department      string
	UserCount       int64
	AgentCount      int64
	UtilizationPct  float64
	SessionsPerUser float64
}

// Departments breaks activity down per department for the period.
func (s *Store) Departments(ctx context.Context, days int) ([]Department, error) {
	deptMap, err := s.departments(ctx)
	if err != nil {
		return nil, err
	}
	if len(deptMap) == 0 {
		return []Department{}, nil
	}

	agentCounts := map[string]int64{}
	rows, err := s.DB.Query(ctx, "SELECT created_by::text, count(id) FROM agents GROUP BY created_by")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var uid string
		var cnt int64
		if err := rows.Scan(&uid, &cnt); err != nil {
			rows.Close()
			return nil, err
		}
		agentCounts[uid] = cnt
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	userSessions := chUserCounts(s.chJSON(ctx,
		"SELECT user_id, count() AS sessions "+
			"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL {days:UInt32} DAY "+
			"GROUP BY user_id",
		clickhouse.Settings{"param_days": itoa(days)}), "sessions")

	out := []Department{}
	for _, dept := range sortedKeys(deptMap) {
		userIDs := deptMap[dept]
		item := Department{Department: dept, UserCount: int64(len(userIDs))}
		var active, total int64
		for _, uid := range userIDs {
			item.AgentCount += agentCounts[uid]
			if userSessions[uid] > 0 {
				active++
			}
			total += userSessions[uid]
		}
		if item.UserCount > 0 {
			item.UtilizationPct = round1(float64(active) / float64(item.UserCount) * 100)
			item.SessionsPerUser = round1(float64(total) / float64(item.UserCount))
		}
		out = append(out, item)
	}
	return out, nil
}

// DeptTokens is one department's token consumption and trend.
type DeptTokens struct {
	Department      string
	TokensUsed      int64
	CostPerTask     float64
	SessionsPerUser float64
	TrendPct        float64
}

// DeptTokens aggregates token usage per department across two periods.
// Session telemetry carries no monetary cost, so cost stays zero.
func (s *Store) DeptTokens(ctx context.Context, days int) ([]DeptTokens, error) {
	deptMap, err := s.departments(ctx)
	if err != nil {
		return nil, err
	}
	if len(deptMap) == 0 {
		return []DeptTokens{}, nil
	}
	type usage struct{ tokens, traces int64 }
	current := map[string]usage{}
	for _, r := range s.chJSON(ctx,
		"SELECT user_id, sum(input_tokens + output_tokens) AS tokens, "+
			"count() AS traces "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL {days:UInt32} DAY "+
			"GROUP BY user_id",
		clickhouse.Settings{"param_days": itoa(days)}) {
		uid, _ := r["user_id"].(string)
		current[uid] = usage{tokens: chInt(r, "tokens"), traces: chInt(r, "traces")}
	}
	previous := chUserCounts(s.chJSON(ctx,
		"SELECT user_id, sum(input_tokens + output_tokens) AS tokens "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL {days2:UInt32} DAY "+
			"AND first_event_time < now() - INTERVAL {days:UInt32} DAY "+
			"GROUP BY user_id",
		clickhouse.Settings{"param_days": itoa(days), "param_days2": itoa(days * 2)}), "tokens")

	out := []DeptTokens{}
	for _, dept := range sortedKeys(deptMap) {
		userIDs := deptMap[dept]
		var tokens, traces, prevTokens int64
		for _, uid := range userIDs {
			tokens += current[uid].tokens
			traces += current[uid].traces
			prevTokens += previous[uid]
		}
		item := DeptTokens{Department: dept, TokensUsed: tokens, TrendPct: trendPercent(tokens, prevTokens)}
		if len(userIDs) > 0 {
			item.SessionsPerUser = round1(float64(traces) / float64(len(userIDs)))
		}
		out = append(out, item)
	}
	return out, nil
}

// CostMonth is one month's spend and savings; both stay zero until session
// telemetry carries a real monetary value.
type CostMonth struct {
	Month string
}

// CostSummary reports whether baselines are configured plus the monthly
// activity months; monetary figures await cost-bearing telemetry.
type CostSummary struct {
	Configured bool
	Months     []string
}

// CostSummary loads the configuration flag and activity months.
func (s *Store) CostSummary(ctx context.Context) (CostSummary, error) {
	cfg, err := s.GetConfig(ctx)
	if err != nil {
		return CostSummary{}, err
	}
	if cfg == nil {
		return CostSummary{Configured: false, Months: []string{}}, nil
	}
	out := CostSummary{Configured: true, Months: []string{}}
	for _, r := range s.chJSON(ctx,
		"SELECT toStartOfMonth(first_event_time) AS month "+
			"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL 12 MONTH "+
			"GROUP BY month ORDER BY month", nil) {
		month, _ := r["month"].(string)
		if len(month) > 7 {
			month = month[:7]
		}
		out.Months = append(out.Months, month)
	}
	return out, nil
}

// chUserCounts flattens a user_id keyed count column.
func chUserCounts(rows []map[string]any, key string) map[string]int64 {
	out := map[string]int64{}
	for _, r := range rows {
		uid, _ := r["user_id"].(string)
		out[uid] = chInt(r, key)
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
