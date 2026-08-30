// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// WorkspaceCH is the analytics-store surface Project Intelligence needs.
type WorkspaceCH interface {
	QueryJSON(ctx context.Context, sql string, settings clickhouse.Settings) ([]map[string]any, error)
}

var workspaceRangeDays = map[string]int{"24h": 1, "7d": 7, "30d": 30, "90d": 90}

const workspaceRangePattern = "^(24h|7d|30d|90d)$"

var workspaceRangeRe = regexp.MustCompile(workspaceRangePattern)

const aggregateWindowSQL = `SELECT count() AS sessions, uniqExact(user_id) AS active_users,
	sum(prompt_count) AS prompts, sum(tool_call_count) AS tool_calls,
	sum(tool_result_count) AS tool_results, sum(input_tokens) AS input_tokens,
	sum(output_tokens) AS output_tokens, sum(total_credits) AS credits
	FROM session_stats_agg FINAL
	WHERE project_id = {pid:String}
	AND last_event_time > now() - INTERVAL {days:UInt32} DAY
	AND last_event_time <= now() - INTERVAL {offset:UInt32} DAY
	SETTINGS do_not_merge_across_partitions_select_final = 1 FORMAT JSON`

const dailyActivitySQL = `SELECT toDate(last_event_time) AS day, count() AS sessions,
	uniqExact(user_id) AS active_users, sum(tool_call_count) AS tool_calls,
	sum(input_tokens) + sum(output_tokens) AS tokens, sum(total_credits) AS credits
	FROM session_stats_agg FINAL
	WHERE project_id = {pid:String}
	AND last_event_time > now() - INTERVAL {days:UInt32} DAY
	GROUP BY day ORDER BY day
	SETTINGS do_not_merge_across_partitions_select_final = 1 FORMAT JSON`

const adoptionUsersSQL = `SELECT countIf(first_seen > now() - INTERVAL {days:UInt32} DAY) AS new_users,
	count() AS active_users FROM (
	SELECT user_id, min(first_event_time) AS first_seen, max(last_event_time) AS last_seen
	FROM session_stats_agg FINAL
	WHERE project_id = {pid:String} AND user_id != '' GROUP BY user_id
	) WHERE last_seen > now() - INTERVAL {days:UInt32} DAY
	SETTINGS do_not_merge_across_partitions_select_final = 1 FORMAT JSON`

const resourceWindowSQL = `SELECT agent_id,
	countIf(last_event_time > now() - INTERVAL {days:UInt32} DAY) AS sessions,
	countIf(last_event_time <= now() - INTERVAL {days:UInt32} DAY) AS previous_sessions,
	sumIf(tool_call_count, last_event_time > now() - INTERVAL {days:UInt32} DAY) AS tool_calls,
	sumIf(tool_result_count, last_event_time > now() - INTERVAL {days:UInt32} DAY) AS tool_results,
	sumIf(input_tokens + output_tokens, last_event_time > now() - INTERVAL {days:UInt32} DAY) AS tokens,
	sumIf(total_credits, last_event_time > now() - INTERVAL {days:UInt32} DAY) AS credits,
	maxIf(last_event_time, last_event_time > now() - INTERVAL {days:UInt32} DAY) AS last_used
	FROM session_stats_agg FINAL
	WHERE project_id = {pid:String} AND agent_id != ''
	AND last_event_time > now() - INTERVAL {days2:UInt32} DAY
	GROUP BY agent_id
	SETTINGS do_not_merge_across_partitions_select_final = 1 FORMAT JSON`

var errWorkspaceTelemetryUnavailable = errors.New("intelligence telemetry unavailable")

type workspaceContext struct {
	project     *Project
	includeCost bool
	days        int
	rng         string
}

type workspaceSource struct {
	Name      string  `json:"name"`
	Status    string  `json:"status"`
	Message   *string `json:"message"`
	UpdatedAt string  `json:"updated_at"`
}

func workspaceSourceState(name, status, message string, now time.Time) workspaceSource {
	state := workspaceSource{Name: name, Status: status, UpdatedAt: now.Format(time.RFC3339)}
	if message != "" {
		state.Message = &message
	}
	return state
}

func (h *Handler) workspaceResolve(w http.ResponseWriter, r *http.Request) (*workspaceContext, bool) {
	userID, ok := h.caller(w, r)
	if !ok {
		return nil, false
	}
	org, err := h.Store.ResolveOrg(r.Context(), r, h.baseDomain(r), r.PathValue("org"), userID)
	if err != nil {
		writeErr(w, r, err)
		return nil, false
	}
	project, err := h.Store.ResolveRequestProject(r.Context(), r, org, r.PathValue("project"), userID)
	if err != nil {
		writeErr(w, r, err)
		return nil, false
	}
	rng := r.URL.Query().Get("range")
	if rng == "" {
		rng = "7d"
	}
	if !workspaceRangeRe.MatchString(rng) {
		writeWorkspacePattern422(w, "range", rng, workspaceRangePattern)
		return nil, false
	}
	projectRole := ""
	if project.Role != nil {
		projectRole = *project.Role
	}
	return &workspaceContext{
		project:     project,
		includeCost: tenancy.CanAdministerProject(org.Role, projectRole),
		days:        workspaceRangeDays[rng],
		rng:         rng,
	}, true
}

func writeWorkspacePattern422(w http.ResponseWriter, param, input, pattern string) {
	httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": []map[string]any{{
		"type": "string_pattern_mismatch", "loc": []string{"query", param},
		"msg": fmt.Sprintf("String should match pattern '%s'", pattern), "input": input,
		"ctx": map[string]any{"pattern": pattern},
	}}})
}

func workspaceIntQueryParam(w http.ResponseWriter, r *http.Request, name string, fallback, maximum int) (int, bool) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > maximum {
		httpapi.WriteError(w, http.StatusUnprocessableEntity,
			fmt.Sprintf("%s must be an integer between 1 and %d", name, maximum))
		return 0, false
	}
	return value, true
}

func (h *Handler) queryWorkspaceRows(
	ctx context.Context, sql string, settings clickhouse.Settings,
) ([]map[string]any, error) {
	if h.CH == nil {
		return nil, errWorkspaceTelemetryUnavailable
	}
	return h.CH.QueryJSON(ctx, sql, settings)
}

func workspaceRowFloat(row map[string]any, key string) float64 {
	switch value := row[key].(type) {
	case float64:
		return value
	case float32:
		return float64(value)
	case int:
		return float64(value)
	case int64:
		return float64(value)
	case string:
		parsed, _ := strconv.ParseFloat(value, 64)
		return parsed
	default:
		return 0
	}
}

func workspaceRowTimestamp(row map[string]any, key string) *string {
	if value, found := row[key]; found && value != nil {
		text := fmt.Sprintf("%v", value)
		if text != "" && text != "1970-01-01 00:00:00" && text != "0000-00-00 00:00:00" {
			return &text
		}
	}
	return nil
}

func workspaceRound(value float64, places int) float64 {
	shift := math.Pow(10, float64(places))
	return math.RoundToEven(value*shift) / shift
}

func workspacePercentChange(current, previous float64) *float64 {
	if previous == 0 {
		return nil
	}
	value := workspaceRound(((current-previous)/previous)*100, 1)
	return &value
}

func workspaceFloatPointer(value float64) *float64 { return &value }
func workspaceIntPointer(value int) *int           { return &value }
