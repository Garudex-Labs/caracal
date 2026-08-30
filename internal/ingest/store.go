// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"context"
	"fmt"
	"time"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// SessionKey identifies one session source for one user.
type SessionKey struct {
	SessionID string
	ProjectID string
	UserID    string
	Harness   string
}

// StoredEvent is a classified row plus its session attribution, matching the
// session_events table columns.
type StoredEvent struct {
	Row
	SessionID        string  `json:"session_id"`
	ProjectID        string  `json:"project_id"`
	UserID           string  `json:"user_id"`
	AgentID          *string `json:"agent_id"`
	AgentVersion     *string `json:"agent_version"`
	LayerHash        *string `json:"layer_hash"`
	ParentSessionID  *string `json:"parent_session_id"`
	RawLineTruncated int     `json:"raw_line_truncated"`
}

// SourcePos is one stored source line position.
type SourcePos struct {
	LineOffset int
	EndOffset  int64
}

// ManifestEntry is one stored source line with its content hash.
type ManifestEntry struct {
	LineOffset   int
	EndOffset    int64
	SourceSHA256 string
}

// Store persists and reads back session events and checkpoints.
type Store interface {
	InsertEvents(ctx context.Context, events []StoredEvent) error
	InsertCheckpoint(ctx context.Context, key SessionKey, line int, offset int64) error
	RefreshSummary(ctx context.Context, key SessionKey) error
	Checkpoint(ctx context.Context, key SessionKey) (line int, offset int64, err error)
	SourceRecordsAfter(ctx context.Context, key SessionKey, afterLine, limit int) ([]SourcePos, error)
	SourceManifest(ctx context.Context, key SessionKey) ([]ManifestEntry, error)
	ExistingLineHashes(ctx context.Context, key SessionKey, minOffset, maxOffset int) (map[int]string, error)
}

// CHStore is the ClickHouse-backed Store.
type CHStore struct {
	Client *clickhouse.Client
}

const insertEventsSQL = "INSERT INTO session_events (session_id, project_id, user_id, agent_id, " +
	"agent_version, layer_hash, harness, line_offset, source_end_offset, line_hash, source_sha256, " +
	"is_source_record, rendered, event_type, timestamp, uuid, parent_uuid, " +
	"tool_name, tool_id, content_preview, content_length, raw_line, credits, parent_session_id, " +
	"input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, raw_line_truncated) FORMAT JSONEachRow"

func (s *CHStore) InsertEvents(ctx context.Context, events []StoredEvent) error {
	if len(events) == 0 {
		return nil
	}
	rows := make([]any, len(events))
	for i := range events {
		rows[i] = &events[i]
	}
	if err := s.Client.InsertJSONEachRow(ctx, insertEventsSQL, rows); err != nil {
		return fmt.Errorf("insert %d session events: %w", len(events), err)
	}
	return nil
}

func (s *CHStore) InsertCheckpoint(ctx context.Context, key SessionKey, line int, offset int64) error {
	row := map[string]any{
		"session_id":          key.SessionID,
		"project_id":          key.ProjectID,
		"user_id":             key.UserID,
		"harness":             key.Harness,
		"acknowledged_line":   line,
		"acknowledged_offset": offset,
		"checkpoint_version":  time.Now().UnixNano(),
	}
	sql := "INSERT INTO session_checkpoints (session_id, project_id, user_id, harness, acknowledged_line, " +
		"acknowledged_offset, checkpoint_version) FORMAT JSONEachRow"
	if err := s.Client.InsertJSONEachRow(ctx, sql, []any{row}); err != nil {
		return fmt.Errorf("insert checkpoint: %w", err)
	}
	return nil
}

func (s *CHStore) RefreshSummary(ctx context.Context, key SessionKey) error {
	sql := "INSERT INTO session_stats_agg " +
		"SELECT project_id, session_id, " +
		"coalesce(anyIf(agent_id, agent_id IS NOT NULL AND agent_id != ''), '') AS agent_id, " +
		"coalesce(anyIf(agent_version, agent_version IS NOT NULL AND agent_version != ''), '') AS agent_version, " +
		"user_id, coalesce(anyIf(parent_session_id, parent_session_id IS NOT NULL), '') AS parent_session_id, " +
		"harness, coalesce(anyIf(layer_hash, layer_hash IS NOT NULL AND layer_hash != ''), '') AS layer_hash, " +
		"minIf(timestamp, rendered = 1 AND timestamp > '1971-01-01 00:00:00' AND timestamp < '2099-01-01 00:00:00') AS first_event_time, " +
		"maxIf(timestamp, rendered = 1 AND timestamp > '1971-01-01 00:00:00' AND timestamp < '2099-01-01 00:00:00') AS last_event_time, " +
		"countIf(rendered = 1) AS event_count, countIf(rendered = 1 AND event_type = 'user_prompt') AS prompt_count, " +
		"countIf(rendered = 1 AND event_type = 'tool_call') AS tool_call_count, " +
		"countIf(rendered = 1 AND event_type = 'tool_result') AS tool_result_count, " +
		"sumIf(input_tokens, rendered = 1) AS input_tokens, sumIf(output_tokens, rendered = 1) AS output_tokens, " +
		"sumIf(cache_read_tokens, rendered = 1) AS cache_read_tokens, " +
		"sumIf(cache_write_tokens, rendered = 1) AS cache_write_tokens, max(credits) AS total_credits, " +
		"anyLastIf(model, rendered = 1 AND model != '') AS model, " +
		"toUInt64(toUnixTimestamp64Milli(now64(3))) AS summary_version, now64(3) AS updated_at " +
		"FROM session_events FINAL WHERE project_id = {pid:String} AND user_id = {uid:String} " +
		"AND harness = {harness:String} AND session_id = {sid:String} " +
		"GROUP BY project_id, session_id, user_id, harness"
	settings := s.keyParams(key)
	settings["wait_for_async_insert"] = "1"
	if err := s.Client.Exec(ctx, sql, settings); err != nil {
		return fmt.Errorf("refresh session summary: %w", err)
	}
	return nil
}

func (s *CHStore) Checkpoint(ctx context.Context, key SessionKey) (int, int64, error) {
	sql := "SELECT acknowledged_line, acknowledged_offset FROM session_checkpoints FINAL " +
		"WHERE project_id = {pid:String} AND user_id = {uid:String} " +
		"AND harness = {harness:String} AND session_id = {sid:String} LIMIT 1 FORMAT JSON"
	rows, err := s.Client.QueryJSON(ctx, sql, s.keyParams(key))
	if err != nil {
		return 0, 0, fmt.Errorf("read checkpoint: %w", err)
	}
	if len(rows) == 0 {
		return -1, 0, nil
	}
	return jsonInt(rows[0]["acknowledged_line"]), int64(jsonInt(rows[0]["acknowledged_offset"])), nil
}

func (s *CHStore) SourceRecordsAfter(ctx context.Context, key SessionKey, afterLine, limit int) ([]SourcePos, error) {
	sql := "SELECT line_offset, source_end_offset FROM session_events FINAL " +
		"WHERE project_id = {pid:String} AND user_id = {uid:String} " +
		"AND harness = {harness:String} AND session_id = {sid:String} " +
		"AND is_source_record = 1 AND line_offset > {after:Int64} " +
		"ORDER BY line_offset LIMIT {limit:UInt32} FORMAT JSON"
	settings := s.keyParams(key)
	settings["param_after"] = fmt.Sprint(afterLine)
	settings["param_limit"] = fmt.Sprint(limit)
	rows, err := s.Client.QueryJSON(ctx, sql, settings)
	if err != nil {
		return nil, fmt.Errorf("read source records: %w", err)
	}
	out := make([]SourcePos, len(rows))
	for i, row := range rows {
		out[i] = SourcePos{LineOffset: jsonInt(row["line_offset"]), EndOffset: int64(jsonInt(row["source_end_offset"]))}
	}
	return out, nil
}

func (s *CHStore) SourceManifest(ctx context.Context, key SessionKey) ([]ManifestEntry, error) {
	sql := "SELECT line_offset, source_end_offset, source_sha256 FROM session_events FINAL " +
		"WHERE project_id = {pid:String} AND user_id = {uid:String} " +
		"AND harness = {harness:String} AND session_id = {sid:String} " +
		"AND is_source_record = 1 ORDER BY line_offset FORMAT JSON"
	rows, err := s.Client.QueryJSON(ctx, sql, s.keyParams(key))
	if err != nil {
		return nil, fmt.Errorf("read source manifest: %w", err)
	}
	out := make([]ManifestEntry, len(rows))
	for i, row := range rows {
		hash, _ := row["source_sha256"].(string)
		out[i] = ManifestEntry{
			LineOffset:   jsonInt(row["line_offset"]),
			EndOffset:    int64(jsonInt(row["source_end_offset"])),
			SourceSHA256: hash,
		}
	}
	return out, nil
}

func (s *CHStore) ExistingLineHashes(ctx context.Context, key SessionKey, minOffset, maxOffset int) (map[int]string, error) {
	if minOffset > maxOffset {
		return map[int]string{}, nil
	}
	sql := "SELECT line_offset, line_hash FROM session_events FINAL " +
		"WHERE project_id = {pid:String} AND user_id = {uid:String} " +
		"AND harness = {harness:String} AND session_id = {sid:String} AND is_source_record = 1 " +
		"AND line_offset >= {min_off:UInt32} AND line_offset <= {max_off:UInt32} FORMAT JSON"
	settings := s.keyParams(key)
	settings["param_min_off"] = fmt.Sprint(minOffset)
	settings["param_max_off"] = fmt.Sprint(maxOffset)
	rows, err := s.Client.QueryJSON(ctx, sql, settings)
	if err != nil {
		return nil, fmt.Errorf("dedup query: %w", err)
	}
	out := make(map[int]string, len(rows))
	for _, row := range rows {
		hash, _ := row["line_hash"].(string)
		out[jsonInt(row["line_offset"])] = hash
	}
	return out, nil
}

func (s *CHStore) keyParams(key SessionKey) clickhouse.Settings {
	return clickhouse.Settings{
		"param_pid":     key.ProjectID,
		"param_uid":     key.UserID,
		"param_harness": key.Harness,
		"param_sid":     key.SessionID,
	}
}

// jsonInt reads a ClickHouse FORMAT JSON numeric cell, which arrives as a
// float64 or as a string for 64-bit columns.
func jsonInt(v any) int {
	return intOf(v)
}
