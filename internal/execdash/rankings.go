// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package execdash

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// TopAgentScored is one agent's composite ranking row.
type TopAgentScored struct {
	ID             string
	Name           string
	Category       string
	CompositeScore float64
	Sessions       int64
	Downloads      int64
	WeeklyTrend    []int64
}

// TopAgents ranks agents by a session and download composite.
func (s *Store) TopAgents(ctx context.Context, limit int) ([]TopAgentScored, error) {
	downloads := map[string]int64{}
	rows, err := s.DB.Query(ctx,
		"SELECT agent_id::text, count(id) FROM agent_download_records GROUP BY agent_id")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		var cnt int64
		if err := rows.Scan(&id, &cnt); err != nil {
			rows.Close()
			return nil, err
		}
		downloads[id] = cnt
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	sessions := map[string]int64{}
	for _, r := range s.chJSON(ctx,
		"SELECT agent_id, count() AS sessions "+
			"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
			"AND agent_id != '' AND first_event_time >= now() - INTERVAL 30 DAY "+
			"GROUP BY agent_id ORDER BY sessions DESC LIMIT 50", nil) {
		id, _ := r["agent_id"].(string)
		sessions[id] = chInt(r, "sessions")
	}

	trends := map[string][]int64{}
	for _, r := range s.chJSON(ctx,
		"SELECT agent_id, toStartOfWeek(first_event_time) AS week, count() AS cnt "+
			"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
			"AND agent_id != '' AND first_event_time >= now() - INTERVAL 6 WEEK "+
			"GROUP BY agent_id, week ORDER BY agent_id, week", nil) {
		id, _ := r["agent_id"].(string)
		trends[id] = append(trends[id], chInt(r, "cnt"))
	}

	ids := []string{}
	seen := map[string]bool{}
	for id := range sessions {
		seen[id] = true
	}
	for id := range downloads {
		seen[id] = true
	}
	for id := range seen {
		if _, err := uuid.Parse(id); err == nil {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return []TopAgentScored{}, nil
	}

	type info struct{ name, category string }
	agents := map[string]info{}
	infoRows, err := s.DB.Query(ctx,
		"SELECT id::text, name, category FROM agents WHERE id = ANY($1::uuid[])", ids)
	if err != nil {
		return nil, err
	}
	defer infoRows.Close()
	for infoRows.Next() {
		var id, name string
		var category *string
		if err := infoRows.Scan(&id, &name, &category); err != nil {
			return nil, err
		}
		cat := "Uncategorized"
		if category != nil && *category != "" {
			cat = *category
		}
		agents[id] = info{name: name, category: cat}
	}
	if err := infoRows.Err(); err != nil {
		return nil, err
	}

	var maxDownloads, maxSessions int64 = 1, 1
	for _, v := range downloads {
		if v > maxDownloads {
			maxDownloads = v
		}
	}
	for _, v := range sessions {
		if v > maxSessions {
			maxSessions = v
		}
	}

	out := []TopAgentScored{}
	for id, meta := range agents {
		item := TopAgentScored{
			ID: id, Name: meta.name, Category: meta.category,
			Sessions: sessions[id], Downloads: downloads[id],
			WeeklyTrend: trends[id],
		}
		if item.WeeklyTrend == nil {
			item.WeeklyTrend = []int64{}
		}
		dlNorm := float64(item.Downloads) / float64(maxDownloads) * 100
		sessNorm := float64(item.Sessions) / float64(maxSessions) * 100
		item.CompositeScore = round1(dlNorm*0.4 + sessNorm*0.6)
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CompositeScore != out[j].CompositeScore {
			return out[i].CompositeScore > out[j].CompositeScore
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// ModelComparison is one model's usage row for the strategic view.
type ModelComparison struct {
	Model       string
	Sessions    int64
	AvgTokens   int64
	SuccessRate float64
	BestAt      string
}

// DepartmentGap is one department's adoption reading.
type DepartmentGap struct {
	Department  string
	AdoptionPct float64
	Sessions    int64
	Opportunity string
}

// PlatformComparisonRow is one harness's completion profile.
type PlatformComparisonRow struct {
	Platform      string
	AvgTaskTimeMs float64
	Sessions      int64
	SuccessRate   float64
}

// StrategicInsights is the deployment analysis payload.
type StrategicInsights struct {
	ModelComparison    []ModelComparison
	DepartmentGaps     []DepartmentGap
	PlatformComparison []PlatformComparisonRow
	PowerUserValuePct  float64
	TotalActiveUsers   int64
	AutomatablePct     float64
}

// StrategicInsights derives the deployment analysis from telemetry.
func (s *Store) StrategicInsights(ctx context.Context) (StrategicInsights, error) {
	out := StrategicInsights{
		ModelComparison:    []ModelComparison{},
		DepartmentGaps:     []DepartmentGap{},
		PlatformComparison: []PlatformComparisonRow{},
	}

	modelRows := s.chJSON(ctx,
		"SELECT model, "+
			"count() AS sessions, "+
			"round(avg(input_tokens + output_tokens)) AS avg_tokens "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' AND model != '' "+
			"GROUP BY model "+
			"HAVING sessions >= 5 "+
			"ORDER BY sessions DESC "+
			"LIMIT 10", nil)
	successMap := map[string]float64{}
	for _, r := range s.chJSON(ctx,
		"SELECT model, "+
			"countIf(event_count > 5 AND prompt_count >= 1) AS successes, "+
			"count() AS total "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' AND model != '' "+
			"AND first_event_time >= now() - INTERVAL 30 DAY "+
			"GROUP BY model HAVING total >= 5", nil) {
		if total := chInt(r, "total"); total > 0 {
			model, _ := r["model"].(string)
			successMap[model] = round1(float64(chInt(r, "successes")) / float64(total) * 100)
		}
	}
	if len(modelRows) > 0 {
		mostUsed := chInt(modelRows[0], "sessions")
		for _, r := range modelRows {
			model, _ := r["model"].(string)
			item := ModelComparison{
				Model: model, Sessions: chInt(r, "sessions"),
				AvgTokens: chFloatInt(r, "avg_tokens"), SuccessRate: successMap[model],
			}
			switch {
			case item.Sessions == mostUsed:
				item.BestAt = "Most popular, proven reliability"
			case item.AvgTokens > 5000:
				item.BestAt = "Complex/long-context tasks"
			default:
				item.BestAt = "General purpose"
			}
			out.ModelComparison = append(out.ModelComparison, item)
		}
	}

	deptMap, err := s.departments(ctx)
	if err != nil {
		return out, err
	}
	userSessions := chUserCounts(s.chJSON(ctx,
		"SELECT user_id, count() AS sessions FROM session_stats_agg FINAL WHERE project_id = '{project_id}' GROUP BY user_id", nil), "sessions")
	for _, dept := range sortedKeys(deptMap) {
		if dept == "Unassigned" {
			continue
		}
		userIDs := deptMap[dept]
		var active, total int64
		for _, uid := range userIDs {
			if userSessions[uid] > 0 {
				active++
			}
			total += userSessions[uid]
		}
		gap := DepartmentGap{Department: dept, Sessions: total}
		if len(userIDs) > 0 {
			gap.AdoptionPct = round1(float64(active) / float64(len(userIDs)) * 100)
		}
		switch {
		case gap.AdoptionPct < 50:
			gap.Opportunity = itoa(len(userIDs)-int(active)) + " users not using AI - potential for automation"
		case gap.AdoptionPct < 80:
			gap.Opportunity = "Moderate adoption, room for deeper integration"
		default:
			gap.Opportunity = "High adoption - focus on optimization"
		}
		out.DepartmentGaps = append(out.DepartmentGaps, gap)
	}
	sort.SliceStable(out.DepartmentGaps, func(i, j int) bool {
		return out.DepartmentGaps[i].AdoptionPct < out.DepartmentGaps[j].AdoptionPct
	})

	for _, r := range s.chJSON(ctx,
		"SELECT harness, "+
			"round(avg(dateDiff('millisecond', first_event_time, last_event_time))) AS avg_time_ms, "+
			"count() AS sessions, "+
			"countIf(event_count > 2) AS completed "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' AND harness != '' "+
			"AND first_event_time != last_event_time "+
			"GROUP BY harness "+
			"HAVING sessions >= 5 "+
			"ORDER BY sessions DESC", nil) {
		platform, _ := r["harness"].(string)
		row := PlatformComparisonRow{
			Platform: platform, Sessions: chInt(r, "sessions"),
			AvgTaskTimeMs: chFloat(r, "avg_time_ms"),
		}
		if row.Sessions > 0 {
			row.SuccessRate = round1(float64(chInt(r, "completed")) / float64(row.Sessions) * 100)
		}
		out.PlatformComparison = append(out.PlatformComparison, row)
	}

	valueRows := s.chJSON(ctx,
		"SELECT user_id, count() AS sessions, sum(input_tokens + output_tokens) AS value "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL 30 DAY "+
			"GROUP BY user_id "+
			"ORDER BY value DESC", nil)
	out.TotalActiveUsers = int64(len(valueRows))
	if out.TotalActiveUsers > 0 {
		top := len(valueRows) / 5
		if top < 1 {
			top = 1
		}
		var totalValue, topValue float64
		for i, r := range valueRows {
			v := chFloat(r, "value")
			totalValue += v
			if i < top {
				topValue += v
			}
		}
		if totalValue > 0 {
			out.PowerUserValuePct = round1(topValue / totalValue * 100)
		}
	}

	autoRows := s.chJSON(ctx,
		"SELECT "+
			"countIf((input_tokens + output_tokens) < 3000 AND event_count <= 5) AS simple, "+
			"count() AS total "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL 30 DAY", nil)
	if len(autoRows) > 0 {
		if total := chInt(autoRows[0], "total"); total > 0 {
			out.AutomatablePct = round1(float64(chInt(autoRows[0], "simple")) / float64(total) * 100)
		}
	}
	return out, nil
}

// Developer is one user's activity row.
type Developer struct {
	UserID     string
	Name       string
	Department string
	Sessions   int64
	Tokens     int64
	Percentile int64
}

// DeveloperBreakdown carries per-developer activity with percentiles.
type DeveloperBreakdown struct {
	TotalDevelopers  int64
	ActiveDevelopers int64
	Top20ValuePct    float64
	Developers       []Developer
}

// DeveloperBreakdown ranks users by session volume for the last month.
func (s *Store) DeveloperBreakdown(ctx context.Context, limit int) (DeveloperBreakdown, error) {
	out := DeveloperBreakdown{Developers: []Developer{}}
	if err := s.DB.QueryRow(ctx, "SELECT count(id) FROM users").Scan(&out.TotalDevelopers); err != nil {
		return out, err
	}
	userRows := s.chJSON(ctx,
		"SELECT user_id, "+
			"count() AS sessions, "+
			"sumIf(input_tokens + output_tokens, input_tokens IS NOT NULL) AS tokens "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL 30 DAY "+
			"GROUP BY user_id "+
			"ORDER BY sessions DESC", nil)
	out.ActiveDevelopers = int64(len(userRows))

	var totalValue, topValue int64
	top := len(userRows) / 5
	if top < 1 {
		top = 1
	}
	for i, r := range userRows {
		totalValue += chInt(r, "sessions")
		if i < top {
			topValue += chInt(r, "sessions")
		}
	}
	if totalValue > 0 {
		out.Top20ValuePct = round1(float64(topValue) / float64(totalValue) * 100)
	}

	window := userRows
	if len(window) > limit {
		window = window[:limit]
	}
	ids := []string{}
	for _, r := range window {
		if uid, _ := r["user_id"].(string); uid != "" {
			if _, err := uuid.Parse(uid); err == nil {
				ids = append(ids, uid)
			}
		}
	}
	type info struct{ name, dept string }
	users := map[string]info{}
	if len(ids) > 0 {
		rows, err := s.DB.Query(ctx,
			"SELECT id::text, name, department FROM users WHERE id = ANY($1::uuid[])", ids)
		if err != nil {
			return out, err
		}
		defer rows.Close()
		for rows.Next() {
			var id, name string
			var dept *string
			if err := rows.Scan(&id, &name, &dept); err != nil {
				return out, err
			}
			d := "Unassigned"
			if dept != nil && *dept != "" {
				d = *dept
			}
			users[id] = info{name: name, dept: d}
		}
		if err := rows.Err(); err != nil {
			return out, err
		}
	}
	deptMap, err := s.departments(ctx)
	if err != nil {
		return out, err
	}
	uidDept := map[string]string{}
	for dept, uids := range deptMap {
		for _, uid := range uids {
			uidDept[uid] = dept
		}
	}
	denominator := len(userRows)
	if denominator < 1 {
		denominator = 1
	}
	for i, r := range window {
		uid, _ := r["user_id"].(string)
		meta, ok := users[uid]
		if !ok {
			meta = info{name: "Unknown", dept: "Unassigned"}
		}
		dept := meta.dept
		if d, ok := uidDept[uid]; ok {
			dept = d
		}
		percentile := int64(100 - (i*100)/denominator)
		if percentile < 1 {
			percentile = 1
		}
		out.Developers = append(out.Developers, Developer{
			UserID: uid, Name: meta.name, Department: dept,
			Sessions: chInt(r, "sessions"), Tokens: chInt(r, "tokens"),
			Percentile: percentile,
		})
	}
	return out, nil
}

// InactiveAgent and InactiveUser are churn-alert rows: active in the prior
// fortnight window but silent in the last one.
type InactiveAgent struct {
	ID               string
	Name             string
	Category         string
	PreviousSessions int64
}

// InactiveUser mirrors InactiveAgent for users.
type InactiveUser struct {
	UserID           string
	Name             string
	Department       string
	PreviousSessions int64
}

// InactivityAlerts finds agents and users that went quiet.
func (s *Store) InactivityAlerts(ctx context.Context) ([]InactiveAgent, []InactiveUser, error) {
	churnRows := func(column string) ([]map[string]any, map[string]bool) {
		filter := ""
		if column == "agent_id" {
			filter = "AND " + column + " != '' "
		}
		prev := s.chJSON(ctx,
			"SELECT "+column+", count() AS sessions "+
				"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
				filter+
				"AND first_event_time >= now() - INTERVAL 28 DAY "+
				"AND first_event_time < now() - INTERVAL 14 DAY "+
				"GROUP BY "+column+" HAVING sessions >= 5", nil)
		recent := map[string]bool{}
		for _, r := range s.chJSON(ctx,
			"SELECT "+column+" "+
				"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
				filter+
				"AND first_event_time >= now() - INTERVAL 14 DAY "+
				"GROUP BY "+column, nil) {
			id, _ := r[column].(string)
			recent[id] = true
		}
		churned := []map[string]any{}
		for _, r := range prev {
			if id, _ := r[column].(string); !recent[id] {
				churned = append(churned, r)
			}
		}
		return churned, recent
	}

	churnedAgents, _ := churnRows("agent_id")
	agentIDs := []string{}
	for _, r := range churnedAgents {
		if id, _ := r["agent_id"].(string); id != "" {
			if _, err := uuid.Parse(id); err == nil {
				agentIDs = append(agentIDs, id)
			}
		}
	}
	type info struct{ name, category string }
	agents := map[string]info{}
	if len(agentIDs) > 0 {
		rows, err := s.DB.Query(ctx,
			"SELECT id::text, name, category FROM agents WHERE id = ANY($1::uuid[])", agentIDs)
		if err != nil {
			return nil, nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id, name string
			var category *string
			if err := rows.Scan(&id, &name, &category); err != nil {
				return nil, nil, err
			}
			cat := "Uncategorized"
			if category != nil && *category != "" {
				cat = *category
			}
			agents[id] = info{name: name, category: cat}
		}
		if err := rows.Err(); err != nil {
			return nil, nil, err
		}
	}
	inactiveAgents := []InactiveAgent{}
	limit := 10
	for i, r := range churnedAgents {
		if i >= limit {
			break
		}
		id, _ := r["agent_id"].(string)
		if meta, ok := agents[id]; ok {
			inactiveAgents = append(inactiveAgents, InactiveAgent{
				ID: id, Name: meta.name, Category: meta.category,
				PreviousSessions: chInt(r, "sessions"),
			})
		}
	}

	churnedUsers, _ := churnRows("user_id")
	deptMap, err := s.departments(ctx)
	if err != nil {
		return nil, nil, err
	}
	uidDept := map[string]string{}
	for dept, uids := range deptMap {
		for _, uid := range uids {
			uidDept[uid] = dept
		}
	}
	userIDs := []string{}
	for i, r := range churnedUsers {
		if i >= limit {
			break
		}
		if id, _ := r["user_id"].(string); id != "" {
			if _, err := uuid.Parse(id); err == nil {
				userIDs = append(userIDs, id)
			}
		}
	}
	userNames := map[string]string{}
	if len(userIDs) > 0 {
		rows, err := s.DB.Query(ctx,
			"SELECT id::text, name FROM users WHERE id = ANY($1::uuid[])", userIDs)
		if err != nil {
			return nil, nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id, name string
			if err := rows.Scan(&id, &name); err != nil {
				return nil, nil, err
			}
			userNames[id] = name
		}
		if err := rows.Err(); err != nil {
			return nil, nil, err
		}
	}
	inactiveUsers := []InactiveUser{}
	for i, r := range churnedUsers {
		if i >= limit {
			break
		}
		uid, _ := r["user_id"].(string)
		name, ok := userNames[uid]
		if !ok {
			name = "Unknown"
		}
		dept, ok := uidDept[uid]
		if !ok {
			dept = "Unassigned"
		}
		inactiveUsers = append(inactiveUsers, InactiveUser{
			UserID: uid, Name: name, Department: dept,
			PreviousSessions: chInt(r, "sessions"),
		})
	}
	return inactiveAgents, inactiveUsers, nil
}

// TimeToValueAgent is one agent's ramp reading.
type TimeToValueAgent struct {
	ID              string
	Name            string
	Category        string
	CreatedAt       string
	DaysTo100       *int64
	CurrentSessions int64
}

// TimeToValue reports days from creation to one hundred sessions.
func (s *Store) TimeToValue(ctx context.Context) ([]TimeToValueAgent, *float64, error) {
	type agentRow struct {
		id, name, category string
		createdAt          *time.Time
	}
	agentRows := []agentRow{}
	rows, err := s.DB.Query(ctx, "SELECT id::text, name, category, created_at FROM agents")
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var a agentRow
		var category *string
		if err := rows.Scan(&a.id, &a.name, &category, &a.createdAt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		a.category = "Uncategorized"
		if category != nil && *category != "" {
			a.category = *category
		}
		agentRows = append(agentRows, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if len(agentRows) == 0 {
		return []TimeToValueAgent{}, nil, nil
	}

	type sessInfo struct {
		total int64
	}
	sessMap := map[string]sessInfo{}
	over100 := []string{}
	for _, r := range s.chJSON(ctx,
		"SELECT agent_id, min(first_event_time) AS first_session, count() AS total_sessions "+
			"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
			"AND agent_id != '' "+
			"GROUP BY agent_id", nil) {
		id, _ := r["agent_id"].(string)
		total := chInt(r, "total_sessions")
		sessMap[id] = sessInfo{total: total}
		if total >= 100 {
			over100 = append(over100, id)
		}
	}
	milestone := map[string]string{}
	if len(over100) > 0 {
		if len(over100) > 20 {
			over100 = over100[:20]
		}
		params := clickhouse.Settings{}
		placeholders := make([]string, len(over100))
		for i, id := range over100 {
			name := fmt.Sprintf("aid_%d", i)
			placeholders[i] = "{" + name + ":String}"
			params["param_"+name] = id
		}
		for _, r := range s.chJSON(ctx,
			"SELECT agent_id, first_event_time AS start_time "+
				"FROM ("+
				"  SELECT agent_id, first_event_time, "+
				"    row_number() OVER (PARTITION BY agent_id ORDER BY first_event_time) AS rn "+
				"  FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
				"  AND agent_id IN ("+strings.Join(placeholders, ", ")+")"+
				") WHERE rn = 100",
			params) {
			id, _ := r["agent_id"].(string)
			start, _ := r["start_time"].(string)
			milestone[id] = start
		}
	}

	items := []TimeToValueAgent{}
	daysSum := int64(0)
	daysCount := 0
	for _, a := range agentRows {
		item := TimeToValueAgent{
			ID: a.id, Name: a.name, Category: a.category,
			CurrentSessions: sessMap[a.id].total,
		}
		if a.createdAt != nil {
			item.CreatedAt = a.createdAt.UTC().Format("2006-01-02")
		}
		if start, ok := milestone[a.id]; ok && a.createdAt != nil {
			if ts, err := time.Parse("2006-01-02 15:04:05.000", start); err == nil {
				days := int64(ts.Sub(a.createdAt.UTC()).Hours() / 24)
				if days < 0 {
					days = 0
				}
				item.DaysTo100 = &days
				daysSum += days
				daysCount++
			}
		}
		items = append(items, item)
	}
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].CurrentSessions > items[j].CurrentSessions
	})
	if len(items) > 20 {
		items = items[:20]
	}
	var avg *float64
	if daysCount > 0 {
		v := round1(float64(daysSum) / float64(daysCount))
		avg = &v
	}
	return items, avg, nil
}

func chFloat(row map[string]any, key string) float64 {
	switch v := row[key].(type) {
	case float64:
		return v
	case string:
		f, _ := strconv.ParseFloat(v, 64)
		return f
	}
	return 0
}

func chFloatInt(row map[string]any, key string) int64 {
	return int64(chFloat(row, key))
}
