// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package execdash

import (
	"context"
	"fmt"
	"sort"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// trendPercent mirrors the period-over-period growth contract: an empty
// previous period reads as full growth when there is any current activity.
func trendPercent(current, previous int64) float64 {
	if previous == 0 {
		if current > 0 {
			return 100.0
		}
		return 0.0
	}
	return round1(float64(current-previous) / float64(previous) * 100)
}

// CategoryUsage is one category's session volume and growth.
type CategoryUsage struct {
	Category  string
	Sessions  int64
	GrowthPct float64
}

// UsageByCategory groups agent sessions by catalog category across the
// current and previous periods.
func (s *Store) UsageByCategory(ctx context.Context, days int) ([]CategoryUsage, error) {
	currentRows := s.chJSON(ctx,
		"SELECT agent_id, count() AS cnt FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' AND agent_id != '' "+
			"AND first_event_time >= now() - INTERVAL {days:UInt32} DAY "+
			"GROUP BY agent_id",
		clickhouse.Settings{"param_days": fmt.Sprintf("%d", days)})
	prevRows := s.chJSON(ctx,
		"SELECT agent_id, count() AS cnt FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' AND agent_id != '' "+
			"AND first_event_time >= now() - INTERVAL {days2:UInt32} DAY "+
			"AND first_event_time < now() - INTERVAL {days:UInt32} DAY "+
			"GROUP BY agent_id",
		clickhouse.Settings{"param_days": fmt.Sprintf("%d", days), "param_days2": fmt.Sprintf("%d", days*2)})

	ids := []string{}
	seen := map[string]bool{}
	for _, r := range append(append([]map[string]any{}, currentRows...), prevRows...) {
		id, _ := r["agent_id"].(string)
		if id == "" || seen[id] {
			continue
		}
		if _, err := uuid.Parse(id); err != nil {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	catMap := map[string]string{}
	if len(ids) > 0 {
		rows, err := s.DB.Query(ctx,
			"SELECT id::text, category FROM agents WHERE id = ANY($1::uuid[])", ids)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			var category *string
			if err := rows.Scan(&id, &category); err != nil {
				return nil, err
			}
			name := "Uncategorized"
			if category != nil && *category != "" {
				name = *category
			}
			catMap[id] = name
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	bucket := func(rows []map[string]any) map[string]int64 {
		out := map[string]int64{}
		for _, r := range rows {
			id, _ := r["agent_id"].(string)
			cat, ok := catMap[id]
			if !ok {
				cat = "Uncategorized"
			}
			out[cat] += chInt(r, "cnt")
		}
		return out
	}
	current := bucket(currentRows)
	previous := bucket(prevRows)
	out := make([]CategoryUsage, 0, len(current))
	for cat, sessions := range current {
		out = append(out, CategoryUsage{
			Category: cat, Sessions: sessions,
			GrowthPct: trendPercent(sessions, previous[cat]),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Sessions != out[j].Sessions {
			return out[i].Sessions > out[j].Sessions
		}
		return out[i].Category < out[j].Category
	})
	return out, nil
}

// PlatformCoverage is one harness's reach.
type PlatformCoverage struct {
	Platform string
	Users    int64
	Sessions int64
}

// PlatformCoverage counts distinct users and sessions per harness.
func (s *Store) PlatformCoverage(ctx context.Context) []PlatformCoverage {
	rows := s.chJSON(ctx,
		"SELECT harness, count(DISTINCT user_id) AS users, count() AS sessions "+
			"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
			"AND harness != '' "+
			"GROUP BY harness ORDER BY sessions DESC", nil)
	out := make([]PlatformCoverage, 0, len(rows))
	for _, r := range rows {
		platform, _ := r["harness"].(string)
		out = append(out, PlatformCoverage{
			Platform: platform, Users: chInt(r, "users"), Sessions: chInt(r, "sessions"),
		})
	}
	return out
}

// PlatformScore is one harness's comparison row. Monetary cost and
// structured error fields await richer session ingestion.
type PlatformScore struct {
	Platform       string
	CompositeScore float64
	Sessions       int64
	AvgLatencyMs   float64
	Users          int64
}

// Platforms compares harnesses and scores them by session-based rank.
func (s *Store) Platforms(ctx context.Context) []PlatformScore {
	rows := s.chJSON(ctx,
		"SELECT harness, count() AS sessions, "+
			"count(DISTINCT user_id) AS users, "+
			"round(avg(dateDiff('millisecond', first_event_time, last_event_time)), 1) AS avg_latency_ms "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' AND harness != '' "+
			"GROUP BY harness ORDER BY sessions DESC", nil)
	out := make([]PlatformScore, 0, len(rows))
	for _, r := range rows {
		platform, _ := r["harness"].(string)
		latency := 0.0
		switch v := r["avg_latency_ms"].(type) {
		case float64:
			latency = v
		case string:
			_, _ = fmt.Sscanf(v, "%g", &latency)
		}
		out = append(out, PlatformScore{
			Platform: platform, Sessions: chInt(r, "sessions"),
			AvgLatencyMs: latency, Users: chInt(r, "users"),
		})
	}
	if len(out) > 0 {
		maxSessions := out[0].Sessions
		if maxSessions == 0 {
			maxSessions = 1
		}
		for i := range out {
			out[i].CompositeScore = round1(float64(out[i].Sessions) / float64(maxSessions) * 100)
		}
	}
	return out
}

// VelocityPoint is one week's trace count.
type VelocityPoint struct {
	Week   string
	Traces int64
}

// Velocity carries weekly trace volume with a baseline comparison.
type Velocity struct {
	Weekly            []VelocityPoint
	CurrentWeeklyAvg  float64
	BaselineWeeklyAvg float64
	Multiplier        float64
}

// Velocity buckets the last twelve weeks and compares the first and last
// four-week windows.
func (s *Store) Velocity(ctx context.Context) Velocity {
	rows := s.chJSON(ctx,
		"SELECT toStartOfWeek(first_event_time) AS week, count() AS traces "+
			"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL 12 WEEK "+
			"GROUP BY week ORDER BY week", nil)
	out := Velocity{Weekly: []VelocityPoint{}}
	for _, r := range rows {
		week, _ := r["week"].(string)
		if len(week) > 10 {
			week = week[:10]
		}
		out.Weekly = append(out.Weekly, VelocityPoint{Week: week, Traces: chInt(r, "traces")})
	}
	var baseline, current float64
	switch {
	case len(out.Weekly) >= 4:
		for _, w := range out.Weekly[:4] {
			baseline += float64(w.Traces)
		}
		baseline /= 4
		for _, w := range out.Weekly[len(out.Weekly)-4:] {
			current += float64(w.Traces)
		}
		current /= 4
	case len(out.Weekly) > 0:
		baseline = float64(out.Weekly[0].Traces)
		current = float64(out.Weekly[len(out.Weekly)-1].Traces)
	}
	if baseline > 0 {
		out.Multiplier = round1(current / baseline)
	}
	out.CurrentWeeklyAvg = round1(current)
	out.BaselineWeeklyAvg = round1(baseline)
	return out
}
