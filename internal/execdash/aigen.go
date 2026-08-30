// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package execdash

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// StrategicGenerator produces the structured strategic report from a prompt.
type StrategicGenerator interface {
	Complete(ctx context.Context, prompt, model string, maxTokens int) (map[string]any, error)
}

// SettingsReader resolves the configured generation model.
type SettingsReader interface {
	String(ctx context.Context, key, fallback string) string
}

const strategicPreamble = `You are the AI Strategy Advisor for an engineering organization that uses AI coding agents. You produce strategic insight reports for engineering leadership.

Your reader is a VP of Engineering, CTO, or Head of Platform who needs to understand:
- Where is AI delivering ROI and where is it wasting money?
- Which teams are underserving themselves by not adopting AI?
- What specific actions would save money or improve productivity this month?

Writing style:
- EXECUTIVE TONE. Clear, confident, direct. Like a McKinsey consultant who actually understands engineering.
- SPECIFIC. Every recommendation must cite actual numbers from the data. Never be vague.
- ACTIONABLE. Every insight must end with a concrete action someone can take this week.
- HONEST. If adoption is low, say so. If spend is wasteful, call it out.
- QUANTIFIED. Always include dollar amounts, percentages, or time savings.

Output valid JSON only. No markdown, no code fences.`

const strategicPrompt = `Analyze this deployment's AI usage telemetry and produce strategic recommendations.

## Deployment Telemetry Data
{data_block}

Produce a JSON object with this EXACT structure:
{
  "quick_wins": [
    {
      "title": "<imperative headline, e.g. 'Stop routing simple tasks to Claude Opus'>",
      "detail": "<2-3 sentences with specific numbers explaining the problem and the fix>",
      "estimated_savings": "<dollar amount per month, e.g. '$3,800/mo'>",
      "effort": "low"
    }
  ],
  "adoption_gaps": [
    {
      "title": "<headline about the gap>",
      "detail": "<2-3 sentences with specific adoption %, user counts, and what they're missing>",
      "impact": "high"
    }
  ],
  "platform_insight": {
    "title": "<headline comparing harness/platform performance>",
    "detail": "<2-3 sentences comparing platforms with specific metrics like task time, success rate, sessions>"
  },
  "model_insight": {
    "title": "<headline about model cost-efficiency>",
    "detail": "<2-3 sentences comparing models with costs, success rates, and a clear recommendation>"
  },
  "automation_opportunity": {
    "title": "<headline about what % of work could be automated>",
    "detail": "<2-3 sentences about routine tasks that could run autonomous with approval gates>"
  },
  "usage_pattern": {
    "title": "<headline about power users vs underutilizers>",
    "detail": "<2-3 sentences about user distribution and what training the middle tier could unlock>"
  }
}

Rules:
- quick_wins: 2-4 items, each MUST have a dollar savings estimate. Only include if the data supports it.
- adoption_gaps: 1-3 items, only departments/teams below 50% adoption. If all are high, return empty array.
- platform_insight: compare harnesses/platforms by task completion time and success rate. If only one platform exists, focus on its performance.
- model_insight: compare model costs and recommend the best default. If only one model, say so.
- automation_opportunity: estimate what % of sessions are routine (low tokens, few events) and could run unattended.
- usage_pattern: describe the power user distribution and what the middle tier is missing.
- If data is insufficient for any section, still return the key with title "Insufficient data" and a brief explanation of what's needed.
- All numbers must come from the provided data. Do NOT invent statistics.`

// aiInsightsResponse is the wire form of a generated strategic report.
type aiInsightsResponse struct {
	QuickWins             []map[string]any `json:"quick_wins"`
	AdoptionGaps          []map[string]any `json:"adoption_gaps"`
	PlatformInsight       map[string]any   `json:"platform_insight"`
	ModelInsight          map[string]any   `json:"model_insight"`
	AutomationOpportunity map[string]any   `json:"automation_opportunity"`
	UsagePattern          map[string]any   `json:"usage_pattern"`
	Generated             bool             `json:"generated"`
	GeneratedAt           *string          `json:"generated_at"`
}

// resolveUserDepartments maps departments to user ids: explicit groups win,
// then the profile department, and the remainder lands in Unassigned.
func (s *Store) resolveUserDepartments(ctx context.Context) (map[string][]string, error) {
	deptMap := map[string][]string{}
	assigned := map[string]bool{}

	rows, err := s.DB.Query(ctx, `SELECT group_name, user_id::text FROM user_groups`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var group, userID string
		if err := rows.Scan(&group, &userID); err != nil {
			rows.Close()
			return nil, err
		}
		deptMap[group] = append(deptMap[group], userID)
		assigned[userID] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.DB.Query(ctx, `SELECT id::text, department FROM users WHERE department IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var userID, dept string
		if err := rows.Scan(&userID, &dept); err != nil {
			rows.Close()
			return nil, err
		}
		if assigned[userID] {
			continue
		}
		deptMap[dept] = append(deptMap[dept], userID)
		assigned[userID] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.DB.Query(ctx, `SELECT id::text FROM users`)
	if err != nil {
		return nil, err
	}
	var unassigned []string
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			rows.Close()
			return nil, err
		}
		if !assigned[userID] {
			unassigned = append(unassigned, userID)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(unassigned) > 0 {
		deptMap["Unassigned"] = unassigned
	}
	return deptMap, nil
}

// jsonBlock renders one telemetry section for the prompt.
func jsonBlock(v any) string {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return "{}"
	}
	return string(b)
}

// generateAIInsights collects deployment telemetry, asks the configured
// model for strategic recommendations, and caches the result.
func (h *Handler) generateAIInsights(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var totalUsers int64
	if err := h.Store.DB.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&totalUsers); err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}

	activeRows := h.Store.chJSON(ctx,
		"SELECT count(DISTINCT user_id) AS active "+
			"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL 30 DAY", clickhouse.Settings{})
	activeUsers := int64(0)
	if len(activeRows) > 0 {
		activeUsers = chInt(activeRows[0], "active")
	}
	adoptionPct := 0.0
	if totalUsers > 0 {
		adoptionPct = round1(float64(activeUsers) / float64(totalUsers) * 100)
	}

	modelRows := h.Store.chJSON(ctx,
		"SELECT model, count() AS sessions, "+
			"round(avg(input_tokens + output_tokens)) AS avg_tokens "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' AND model != '' "+
			"GROUP BY model HAVING sessions >= 3 "+
			"ORDER BY sessions DESC LIMIT 10", clickhouse.Settings{})

	platformRows := h.Store.chJSON(ctx,
		"SELECT harness, count() AS sessions, "+
			"count(DISTINCT user_id) AS users, "+
			"round(avg(dateDiff('millisecond', first_event_time, last_event_time)) / 1000) AS avg_task_seconds "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' AND harness != '' "+
			"AND first_event_time != last_event_time "+
			"GROUP BY harness HAVING sessions >= 3 "+
			"ORDER BY sessions DESC", clickhouse.Settings{})

	deptMap, err := h.Store.resolveUserDepartments(ctx)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	sessionRows := h.Store.chJSON(ctx,
		"SELECT user_id, count() AS sessions "+
			"FROM session_stats_agg FINAL WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL 30 DAY "+
			"GROUP BY user_id", clickhouse.Settings{})
	userSessions := map[string]int64{}
	for _, row := range sessionRows {
		userSessions[chStr(row, "user_id")] = chInt(row, "sessions")
	}

	deptNames := make([]string, 0, len(deptMap))
	for name := range deptMap {
		deptNames = append(deptNames, name)
	}
	sort.Strings(deptNames)
	deptData := make([]map[string]any, 0, len(deptNames))
	for _, name := range deptNames {
		if name == "Unassigned" {
			continue
		}
		userIDs := deptMap[name]
		activeCount := 0
		var totalSessions int64
		for _, uid := range userIDs {
			if userSessions[uid] > 0 {
				activeCount++
			}
			totalSessions += userSessions[uid]
		}
		deptAdoption := 0.0
		if len(userIDs) > 0 {
			deptAdoption = round1(float64(activeCount) / float64(len(userIDs)) * 100)
		}
		deptData = append(deptData, map[string]any{
			"department":   name,
			"users":        len(userIDs),
			"active_users": activeCount,
			"adoption_pct": deptAdoption,
			"sessions":     totalSessions,
		})
	}

	autoRows := h.Store.chJSON(ctx,
		"SELECT "+
			"countIf((input_tokens + output_tokens) < 3000 AND event_count <= 5) AS simple, "+
			"count() AS total "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL 30 DAY", clickhouse.Settings{})
	var simpleCount, totalCount int64
	if len(autoRows) > 0 {
		simpleCount = chInt(autoRows[0], "simple")
		totalCount = chInt(autoRows[0], "total")
	}
	automatablePct := 0.0
	if totalCount > 0 {
		automatablePct = round1(float64(simpleCount) / float64(totalCount) * 100)
	}

	devRows := h.Store.chJSON(ctx,
		"SELECT user_id, count() AS sessions "+
			"FROM session_stats_agg FINAL "+
			"WHERE project_id = '{project_id}' "+
			"AND first_event_time >= now() - INTERVAL 30 DAY "+
			"GROUP BY user_id ORDER BY sessions DESC", clickhouse.Settings{})
	var devTotal, top20 int64
	topN := len(devRows) / 5
	if topN < 1 {
		topN = 1
	}
	for i, row := range devRows {
		n := chInt(row, "sessions")
		devTotal += n
		if i < topN {
			top20 += n
		}
	}

	modelComparison := make([]map[string]any, 0, len(modelRows))
	for _, row := range modelRows {
		modelComparison = append(modelComparison, map[string]any{
			"model":      chStr(row, "model"),
			"sessions":   chInt(row, "sessions"),
			"avg_cost":   0.0,
			"avg_tokens": chInt(row, "avg_tokens"),
		})
	}
	platformComparison := make([]map[string]any, 0, len(platformRows))
	for _, row := range platformRows {
		platformComparison = append(platformComparison, map[string]any{
			"platform":         chStr(row, "harness"),
			"sessions":         chInt(row, "sessions"),
			"users":            chInt(row, "users"),
			"avg_task_seconds": chFloat(row, "avg_task_seconds"),
		})
	}

	var block strings.Builder
	writeSection := func(header string, v any) {
		if block.Len() > 0 {
			block.WriteString("\n")
		}
		block.WriteString(header)
		block.WriteString("\n")
		block.WriteString(jsonBlock(v))
	}
	writeSection("## Adoption", map[string]any{
		"total_users":  totalUsers,
		"active_users": activeUsers,
		"adoption_pct": adoptionPct,
	})
	if len(modelComparison) > 0 {
		writeSection("\n## Model Usage Comparison", modelComparison)
	}
	if len(deptData) > 0 {
		writeSection("\n## Department Adoption", deptData)
	}
	if len(platformComparison) > 0 {
		writeSection("\n## Platform/harness Performance", platformComparison)
	}
	writeSection("\n## Developer Activity", map[string]any{
		"total_active":    len(devRows),
		"total_sessions":  devTotal,
		"total_cost":      0.0,
		"top_20_sessions": top20,
	})
	writeSection("\n## Automation Potential", map[string]any{
		"simple_sessions": simpleCount,
		"total_sessions":  totalCount,
		"automatable_pct": automatablePct,
	})

	model := ""
	if h.Settings != nil {
		synthesis := h.Settings.String(ctx, "insights.model_synthesis", "")
		sections := h.Settings.String(ctx, "insights.model_sections", "")
		model = synthesis
		if model == "" {
			model = sections
		}
	}
	var result map[string]any
	if model != "" && h.Strategic != nil {
		prompt := strategicPreamble + "\n\n" + strings.Replace(strategicPrompt, "{data_block}", block.String(), 1)
		result, err = h.Strategic.Complete(ctx, prompt, model, 4096)
		if err != nil {
			result = nil
		}
	}
	if len(result) == 0 {
		httpapi.WriteError(w, http.StatusServiceUnavailable,
			"Insights model is not configured or failed to generate a report")
		return
	}

	generatedAt := time.Now().UTC().Format("2006-01-02T15:04:05.000000+00:00")
	response := aiInsightsResponse{
		QuickWins:             anyMapSlice(result["quick_wins"]),
		AdoptionGaps:          anyMapSlice(result["adoption_gaps"]),
		PlatformInsight:       anyMap(result["platform_insight"]),
		ModelInsight:          anyMap(result["model_insight"]),
		AutomationOpportunity: anyMap(result["automation_opportunity"]),
		UsagePattern:          anyMap(result["usage_pattern"]),
		Generated:             true,
		GeneratedAt:           &generatedAt,
	}
	payload, err := json.Marshal(response)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	if err := h.Redis.Set(ctx, aiInsightsCacheKey, string(payload), 0).Err(); err != nil {
		httpapi.WriteError(w, http.StatusServiceUnavailable, "Executive AI insights cache is unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}

func anyMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func anyMapSlice(v any) []map[string]any {
	out := []map[string]any{}
	items, ok := v.([]any)
	if !ok {
		return out
	}
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func chStr(row map[string]any, key string) string {
	s, _ := row[key].(string)
	return s
}
