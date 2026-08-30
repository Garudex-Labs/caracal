// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// Store answers the analytical queries behind the sessions routes.
type Store interface {
	ListSessions(ctx context.Context, f ListFilter) ([]map[string]any, error)
	QuerySessions(ctx context.Context, f QueryFilter) (*QueryPage, error)
	Summary(ctx context.Context, projectID, userID string) (map[string]any, error)
	Stats(ctx context.Context) (map[string]any, error)
	SessionIdentity(ctx context.Context, sessionID, projectID, userID string) (map[string]any, error)
	SessionRows(ctx context.Context, id Identity, afterOffset *int64) ([]map[string]any, error)
	SubagentRows(ctx context.Context, id Identity, afterOffset *int64) ([]map[string]any, error)
	OwnsSession(ctx context.Context, sessionID, projectID, userID string) (bool, error)
}

// ListFilter narrows the session list.
type ListFilter struct {
	ProjectID string
	Platform  string
	UserIDs   []string
	Days      int
	// OwnerOnly restricts results to OwnerID's sessions (non-admin scope or
	// the mine flag).
	OwnerOnly bool
	OwnerID   string
	Limit     int
	Offset    int
}

// QueryFilter is the investigation listing's unified query: search, facet
// filters, threshold filters, deterministic sort, and offset pagination all
// resolve server-side in one shape.
type QueryFilter struct {
	ProjectID    string
	Search       string
	Platform     string
	Model        string
	AgentID      string
	UserIDs      []string
	Days         int
	Status       string // "", "active", "completed"
	MinDurationS int
	MinTokens    int
	OwnerOnly    bool
	OwnerID      string
	Sort         string // recent|oldest|duration|tokens|credits|prompts|tools
	Limit        int
	Offset       int
}

// QueryPage is one page of the investigation listing plus the window
// statistics the caller needs for grounded anomaly flagging.
type QueryPage struct {
	Items        []map[string]any
	Total        int
	P95DurationS float64
	P95Tokens    float64
}

// Identity pins a session's stable partition for consistent reads.
type Identity struct {
	SessionID string
	ProjectID string
	UserID    string
	Harness   string
}

// CHStore runs the queries against ClickHouse.
type CHStore struct {
	Client *clickhouse.Client
}

// ListSessions reads one row per session from session_stats_agg.
func (s *CHStore) ListSessions(ctx context.Context, f ListFilter) ([]map[string]any, error) {
	whereParts := []string{"project_id = {pid:String}", "session_id != ''", "parent_session_id = ''", "prompt_count > 0"}
	settings := clickhouse.Settings{"param_pid": f.ProjectID}

	if f.OwnerOnly {
		whereParts = append(whereParts, "user_id = {uid:String}")
		settings["param_uid"] = f.OwnerID
	}
	if f.Days > 0 {
		whereParts = append(whereParts, fmt.Sprintf("last_event_time > now() - INTERVAL %d DAY", f.Days))
	}
	if f.Platform != "" {
		whereParts = append(whereParts, "harness = {platform:String}")
		settings["param_platform"] = f.Platform
	}
	if len(f.UserIDs) > 0 {
		placeholders := make([]string, len(f.UserIDs))
		for i, id := range f.UserIDs {
			name := fmt.Sprintf("user_%d", i)
			placeholders[i] = fmt.Sprintf("{%s:String}", name)
			settings["param_"+name] = id
		}
		whereParts = append(whereParts, fmt.Sprintf("user_id IN (%s)", strings.Join(placeholders, ", ")))
	}

	sql := "SELECT " +
		"session_id, " +
		"if(first_event_time > '2020-01-01 00:00:00' AND first_event_time < '2099-01-01 00:00:00', " +
		"   first_event_time, last_event_time) AS first_event_time, " +
		"if(last_event_time < '2099-01-01 00:00:00', last_event_time, first_event_time) AS last_event_time, " +
		"(if(last_event_time < '2099-01-01 00:00:00', last_event_time, first_event_time) > now() - INTERVAL 5 MINUTE) AS is_active, " +
		"prompt_count, " +
		"0                   AS api_request_count, " +
		"tool_result_count, " +
		"input_tokens        AS total_input_tokens, " +
		"output_tokens       AS total_output_tokens, " +
		"cache_read_tokens   AS total_cache_read_tokens, " +
		"cache_write_tokens  AS total_cache_write_tokens, " +
		"total_credits, " +
		"model, " +
		"harness, " +
		"agent_id, " +
		"agent_version, " +
		"user_id " +
		"FROM session_stats_agg FINAL " +
		"WHERE " + strings.Join(whereParts, " AND ") + " " +
		"ORDER BY last_event_time DESC " +
		fmt.Sprintf("LIMIT %d OFFSET %d FORMAT JSON", f.Limit, f.Offset)
	return s.Client.QueryJSON(ctx, sql, settings)
}

// Guarded event-time expressions shared by the query listing: sentinel
// timestamps outside the sane window collapse onto the other bound.
const (
	guardedFirst = "if(first_event_time > '2020-01-01 00:00:00' AND first_event_time < '2099-01-01 00:00:00', " +
		"first_event_time, last_event_time)"
	guardedLast = "if(last_event_time < '2099-01-01 00:00:00', last_event_time, first_event_time)"
)

// querySortKeys maps wire sort names onto deterministic ORDER BY prefixes;
// session_id breaks every tie so pages never overlap or skip.
var querySortKeys = map[string]string{
	"recent":   "last_event_time DESC",
	"oldest":   "first_event_time ASC",
	"duration": "duration_s DESC",
	"tokens":   "total_tokens DESC",
	"credits":  "total_credits DESC",
	"prompts":  "prompt_count DESC",
	"tools":    "tool_result_count DESC",
}

// QuerySessions answers the investigation listing: one filtered subquery
// feeds both the ordered page and the count/percentile aggregate, so the
// result context is always consistent with the visible rows.
func (s *CHStore) QuerySessions(ctx context.Context, f QueryFilter) (*QueryPage, error) {
	whereParts := []string{"project_id = {pid:String}", "session_id != ''", "parent_session_id = ''", "prompt_count > 0"}
	settings := clickhouse.Settings{"param_pid": f.ProjectID}

	if f.OwnerOnly {
		whereParts = append(whereParts, "user_id = {uid:String}")
		settings["param_uid"] = f.OwnerID
	}
	if f.Days > 0 {
		whereParts = append(whereParts, fmt.Sprintf("last_event_time > now() - INTERVAL %d DAY", f.Days))
	}
	if f.Platform != "" {
		whereParts = append(whereParts, "harness = {platform:String}")
		settings["param_platform"] = f.Platform
	}
	if f.Model != "" {
		whereParts = append(whereParts, "positionCaseInsensitive(model, {model:String}) > 0")
		settings["param_model"] = f.Model
	}
	if f.AgentID != "" {
		whereParts = append(whereParts, "agent_id = {agent:String}")
		settings["param_agent"] = f.AgentID
	}
	if f.Search != "" {
		whereParts = append(whereParts,
			"(positionCaseInsensitive(session_id, {q:String}) > 0 OR positionCaseInsensitive(model, {q:String}) > 0)")
		settings["param_q"] = f.Search
	}
	if len(f.UserIDs) > 0 {
		placeholders := make([]string, len(f.UserIDs))
		for i, id := range f.UserIDs {
			name := fmt.Sprintf("user_%d", i)
			placeholders[i] = fmt.Sprintf("{%s:String}", name)
			settings["param_"+name] = id
		}
		whereParts = append(whereParts, fmt.Sprintf("user_id IN (%s)", strings.Join(placeholders, ", ")))
	}

	inner := "SELECT " +
		"session_id, " +
		guardedFirst + " AS first_event_time, " +
		guardedLast + " AS last_event_time, " +
		"(" + guardedLast + " > now() - INTERVAL 5 MINUTE) AS is_active, " +
		"greatest(0, dateDiff('second', " + guardedFirst + ", " + guardedLast + ")) AS duration_s, " +
		"prompt_count, " +
		"0                   AS api_request_count, " +
		"tool_result_count, " +
		"input_tokens        AS total_input_tokens, " +
		"output_tokens       AS total_output_tokens, " +
		"cache_read_tokens   AS total_cache_read_tokens, " +
		"cache_write_tokens  AS total_cache_write_tokens, " +
		"input_tokens + output_tokens AS total_tokens, " +
		"total_credits, " +
		"model, " +
		"harness, " +
		"agent_id, " +
		"agent_version, " +
		"user_id " +
		"FROM session_stats_agg FINAL " +
		"WHERE " + strings.Join(whereParts, " AND ")

	outerParts := []string{"1 = 1"}
	switch f.Status {
	case "active":
		outerParts = append(outerParts, "is_active = 1")
	case "completed":
		outerParts = append(outerParts, "is_active = 0")
	}
	if f.MinDurationS > 0 {
		outerParts = append(outerParts, fmt.Sprintf("duration_s >= %d", f.MinDurationS))
	}
	if f.MinTokens > 0 {
		outerParts = append(outerParts, fmt.Sprintf("total_tokens >= %d", f.MinTokens))
	}
	outerWhere := strings.Join(outerParts, " AND ")

	order, ok := querySortKeys[f.Sort]
	if !ok {
		order = querySortKeys["recent"]
	}

	pageSQL := "SELECT * FROM (" + inner + ") WHERE " + outerWhere + " " +
		"ORDER BY " + order + ", session_id ASC " +
		fmt.Sprintf("LIMIT %d OFFSET %d FORMAT JSON", f.Limit, f.Offset)
	items, err := s.Client.QueryJSON(ctx, pageSQL, settings)
	if err != nil {
		return nil, err
	}

	aggSQL := "SELECT count() AS total, " +
		"quantile(0.95)(duration_s) AS p95_duration_s, " +
		"quantile(0.95)(total_tokens) AS p95_total_tokens " +
		"FROM (" + inner + ") WHERE " + outerWhere + " FORMAT JSON"
	aggRows, err := s.Client.QueryJSON(ctx, aggSQL, settings)
	if err != nil {
		return nil, err
	}
	page := &QueryPage{Items: items}
	if len(aggRows) > 0 {
		page.Total = jsonCount(aggRows[0]["total"])
		page.P95DurationS = jsonFloat(aggRows[0]["p95_duration_s"])
		page.P95Tokens = jsonFloat(aggRows[0]["p95_total_tokens"])
	}
	return page, nil
}

// jsonCount coerces a ClickHouse JSON count, which arrives quoted for
// 64-bit integers.
func jsonCount(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case string:
		parsed, err := strconv.Atoi(v)
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}

// jsonFloat coerces a ClickHouse JSON float that may arrive quoted.
func jsonFloat(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case string:
		parsed, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}

// Summary counts sessions overall and today inside one project, optionally scoped to one user.
func (s *CHStore) Summary(ctx context.Context, projectID, userID string) (map[string]any, error) {
	userFilter := ""
	settings := clickhouse.Settings{"param_pid": projectID}
	if userID != "" {
		userFilter = "AND user_id = {uid:String} "
		settings["param_uid"] = userID
	}
	rows, err := s.Client.QueryJSON(ctx,
		"SELECT "+
			"count() AS total, "+
			"countIf(toDate(last_event_time) = today()) AS today_sessions "+
			"FROM ( "+
			"  SELECT session_id, max(last_event_time) AS last_event_time "+
			"  FROM session_stats_agg FINAL "+
			"  WHERE project_id = {pid:String} AND session_id != '' "+userFilter+"  GROUP BY session_id "+
			") FORMAT JSON", settings)
	if err != nil || len(rows) == 0 {
		return map[string]any{}, err
	}
	return rows[0], nil
}

// Stats aggregates counters across all sessions.
func (s *CHStore) Stats(ctx context.Context) (map[string]any, error) {
	rows, err := s.Client.QueryJSON(ctx,
		"SELECT "+
			"count() AS total_sessions, "+
			"sum(prompt_count) AS total_prompts, "+
			"0 AS total_api_requests, "+
			"sum(tool_call_count) AS total_tool_calls, "+
			"sum(event_count) AS total_events "+
			"FROM ( "+
			"  SELECT session_id, "+
			"    sum(prompt_count) AS prompt_count, "+
			"    sum(tool_call_count) AS tool_call_count, "+
			"    sum(event_count) AS event_count "+
			"  FROM session_stats_agg FINAL "+
			"  WHERE session_id != '' "+
			"  GROUP BY session_id "+
			") FORMAT JSON", nil)
	if err != nil || len(rows) == 0 {
		return map[string]any{}, err
	}
	return rows[0], nil
}

// SessionIdentity returns the session's stable identity columns, scoped to
// the caller when userID is set. Nil means not visible.
func (s *CHStore) SessionIdentity(ctx context.Context, sessionID, projectID, userID string) (map[string]any, error) {
	settings := clickhouse.Settings{"param_sid": sessionID, "param_pid": projectID}
	userFilter := ""
	if userID != "" {
		settings["param_uid"] = userID
		userFilter = "AND user_id = {uid:String} "
	}
	rows, err := s.Client.QueryJSON(ctx,
		"SELECT project_id, user_id, harness FROM session_events FINAL "+
			"WHERE session_id = {sid:String} AND project_id = {pid:String} "+userFilter+
			"ORDER BY ingested_at DESC LIMIT 1 FORMAT JSON", settings)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

const identityFilter = "project_id = {pid:String} AND user_id = {uid:String} AND harness = {harness:String} "

// finalSettings keeps FINAL scans partition-local for speed.
const finalSettings = "SETTINGS max_final_threads = 4, do_not_merge_across_partitions_select_final = 1"

func identitySettings(id Identity) clickhouse.Settings {
	return clickhouse.Settings{
		"param_sid":     id.SessionID,
		"param_pid":     id.ProjectID,
		"param_uid":     id.UserID,
		"param_harness": id.Harness,
	}
}

// SessionRows reads the renderable rows of one session in line order.
func (s *CHStore) SessionRows(ctx context.Context, id Identity, afterOffset *int64) ([]map[string]any, error) {
	settings := identitySettings(id)
	offsetFilter := ""
	if afterOffset != nil {
		offsetFilter = "AND line_offset > {offset:UInt32} "
		settings["param_offset"] = fmt.Sprintf("%d", *afterOffset)
	}
	return s.Client.QueryJSON(ctx,
		"SELECT "+
			"line_offset, timestamp, event_type, content_preview, tool_name, tool_id, "+
			"uuid, parent_uuid, content_length, harness, agent_id, agent_version, raw_line, raw_line_truncated, "+
			"credits, ingested_at "+
			"FROM session_events FINAL "+
			"WHERE session_id = {sid:String} AND "+identityFilter+
			"AND rendered = 1 "+offsetFilter+
			"ORDER BY line_offset ASC "+finalSettings+" FORMAT JSON", settings)
}

// SubagentRows reads renderable rows of the session's subagents, grouped by
// child session in line order.
func (s *CHStore) SubagentRows(ctx context.Context, id Identity, afterOffset *int64) ([]map[string]any, error) {
	settings := identitySettings(id)
	offsetFilter := ""
	if afterOffset != nil {
		offsetFilter = "AND line_offset > {offset:UInt32} "
		settings["param_offset"] = fmt.Sprintf("%d", *afterOffset)
	}
	return s.Client.QueryJSON(ctx,
		"SELECT session_id, timestamp, event_type, content_preview, "+
			"tool_name, tool_id, uuid, parent_uuid, content_length, harness, "+
			"raw_line, raw_line_truncated, credits, ingested_at, line_offset "+
			"FROM session_events FINAL "+
			"WHERE parent_session_id = {sid:String} AND "+identityFilter+
			"AND rendered = 1 "+offsetFilter+
			"ORDER BY session_id, line_offset ASC "+finalSettings+" FORMAT JSON", settings)
}

// OwnsSession reports whether the user has rows in the session.
func (s *CHStore) OwnsSession(ctx context.Context, sessionID, projectID, userID string) (bool, error) {
	rows, err := s.Client.QueryJSON(ctx,
		"SELECT 1 FROM session_events WHERE session_id = {sid:String} AND project_id = {pid:String} AND user_id = {uid:String} LIMIT 1 FORMAT JSON",
		clickhouse.Settings{"param_sid": sessionID, "param_pid": projectID, "param_uid": userID})
	if err != nil {
		return false, err
	}
	return len(rows) > 0, nil
}
