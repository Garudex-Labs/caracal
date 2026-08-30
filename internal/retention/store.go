// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package retention serves the deployment data-retention configuration and
// runs the periodic purge over the analytics and report stores.
package retention

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// DefaultProjectID scopes analytics rows during the single-project phase.
const DefaultProjectID = "default"

// settingsCachePrefix matches the shared dynamic-settings cache slots.
const settingsCachePrefix = "settings:"

// PGQuerier is the subset of a pgx pool these operations need.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// CHClient covers the analytics-store calls the purge and stats need.
type CHClient interface {
	QueryJSON(ctx context.Context, sql string, settings clickhouse.Settings) ([]map[string]any, error)
	Exec(ctx context.Context, sql string, settings clickhouse.Settings) error
	InsertJSONEachRow(ctx context.Context, sql string, rows []any) error
}

// Settings reads the dynamic configuration.
type Settings interface {
	String(ctx context.Context, key, fallback string) string
	Bool(ctx context.Context, key string, fallback bool) bool
	Int(ctx context.Context, key string, fallback int) int
	Invalidate(keys ...string)
}

// Store carries the retention dependencies.
type Store struct {
	DB       PGQuerier
	CH       CHClient
	Settings Settings
	Redis    redis.UniversalClient
}

// Config is the effective retention configuration.
type Config struct {
	Enabled             bool
	DataRetentionDays   int
	ScoreRetentionDays  int
	MaxTraceCount       int
	GlobalRetentionDays int
}

// ReadConfig resolves the retention settings.
func (s *Store) ReadConfig(ctx context.Context) Config {
	return Config{
		Enabled:             s.Settings.Bool(ctx, "retention.enabled", false),
		DataRetentionDays:   s.Settings.Int(ctx, "retention.trace_days", 0),
		ScoreRetentionDays:  s.Settings.Int(ctx, "retention.score_days", 0),
		MaxTraceCount:       s.Settings.Int(ctx, "retention.max_trace_count", 0),
		GlobalRetentionDays: s.Settings.Int(ctx, "data.retention_days", 90),
	}
}

// Update is a validated configuration write.
type Update struct {
	Enabled            bool
	DataRetentionDays  *int
	ScoreRetentionDays *int
	MaxTraceCount      *int
}

// Validate mirrors the request-model rules; the message becomes the 422
// value_error detail.
func (u Update) Validate() error {
	if u.DataRetentionDays != nil && *u.DataRetentionDays < 7 {
		return fmt.Errorf("data_retention_days must be >= 7")
	}
	if u.ScoreRetentionDays != nil && *u.ScoreRetentionDays < 7 {
		return fmt.Errorf("score_retention_days must be >= 7")
	}
	if u.MaxTraceCount != nil && *u.MaxTraceCount < 1000 {
		return fmt.Errorf("max_trace_count must be >= 1000")
	}
	if u.ScoreRetentionDays != nil && u.DataRetentionDays != nil && *u.ScoreRetentionDays < *u.DataRetentionDays {
		return fmt.Errorf("score_retention_days must be >= data_retention_days")
	}
	if u.Enabled && (u.DataRetentionDays == nil || *u.DataRetentionDays == 0) && (u.MaxTraceCount == nil || *u.MaxTraceCount == 0) {
		return fmt.Errorf("At least one of data_retention_days or max_trace_count is required when enabling retention")
	}
	return nil
}

// WriteConfig upserts the configuration rows and drops the shared cache
// slots so every consumer re-reads.
func (s *Store) WriteConfig(ctx context.Context, u Update) error {
	str := func(v *int) string {
		if v == nil || *v == 0 {
			return ""
		}
		return fmt.Sprintf("%d", *v)
	}
	values := map[string]string{
		"retention.enabled":         map[bool]string{true: "true", false: "false"}[u.Enabled],
		"retention.trace_days":      str(u.DataRetentionDays),
		"retention.score_days":      str(u.ScoreRetentionDays),
		"retention.max_trace_count": str(u.MaxTraceCount),
	}
	for key, value := range values {
		if _, err := s.DB.Exec(ctx,
			`INSERT INTO enterprise_config (id, key, value, updated_at)
			 VALUES (gen_random_uuid(), $1, $2, now())
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
			key, value); err != nil {
			return err
		}
		s.Settings.Invalidate(key)
		if s.Redis != nil {
			_ = s.Redis.Del(ctx, settingsCachePrefix+key).Err()
		}
	}
	return nil
}

// EmitSettingEvent records the configuration change in the security trail.
func (s *Store) EmitSettingEvent(ctx context.Context, actorID, actorEmail, actorRole, detail string) {
	_ = s.CH.InsertJSONEachRow(ctx, "INSERT INTO security_events FORMAT JSONEachRow", []any{
		map[string]any{
			"event_id": newEventID(), "timestamp": time.Now().UTC().Format("2006-01-02 15:04:05.000000"),
			"event_type": "admin.setting.changed", "severity": "warning", "actor_id": actorID,
			"actor_email": actorEmail, "actor_role": actorRole, "target_id": "retention",
			"target_type": "setting", "outcome": "success",
			"source_ip": nil, "user_agent": nil, "detail": detail,
		},
	})
}

// chCount runs one count query, degrading to zero on store errors.
func (s *Store) chCount(ctx context.Context, sql string, settings clickhouse.Settings, key string) int64 {
	rows, err := s.CH.QueryJSON(ctx, sql, settings)
	if err != nil || len(rows) == 0 {
		return 0
	}
	return chInt(rows[0], key)
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

// Preview counts what a purge at the given horizon would remove.
func (s *Store) Preview(ctx context.Context, days int) (map[string]any, error) {
	events := s.chCount(ctx,
		"SELECT count() AS cnt FROM session_events "+
			"WHERE project_id = {pid:String} AND timestamp < now() - INTERVAL {days:UInt32} DAY FORMAT JSON",
		clickhouse.Settings{"param_pid": DefaultProjectID, "param_days": strconv.Itoa(days)}, "cnt")

	scoreCutoff := time.Now().UTC().AddDate(0, 0, -days*2)
	var reports int64
	if err := s.DB.QueryRow(ctx,
		`SELECT count(*) FROM insight_reports
		 WHERE agent_id IN (SELECT id FROM agents)
		 AND completed_at < $1 AND status = 'completed'`, scoreCutoff).Scan(&reports); err != nil {
		return nil, err
	}
	return map[string]any{
		"session_events":  events,
		"insight_reports": reports,
		"_note":           "approximate; counts may be higher if a purge ran recently",
	}, nil
}

// Stats summarizes the current trace population against the policy.
func (s *Store) Stats(ctx context.Context) map[string]any {
	config := s.ReadConfig(ctx)
	if !config.Enabled {
		return map[string]any{
			"retention_enabled":     false,
			"data_retention_days":   nilIfZero(config.DataRetentionDays),
			"score_retention_days":  nilIfZero(config.ScoreRetentionDays),
			"total_traces":          0,
			"oldest_trace_age_days": 0,
			"traces_expiring_7d":    0,
			"next_purge_approx":     nil,
		}
	}
	// One pass computes the population, its age, and the expiring slice;
	// a non-positive horizon disables the expiring counter.
	soon := 0
	if config.DataRetentionDays > 7 {
		soon = config.DataRetentionDays - 7
	}
	rows, err := s.CH.QueryJSON(ctx,
		"SELECT count(DISTINCT session_id) AS cnt, "+
			"if(cnt > 0, dateDiff('day', min(timestamp), now()), 0) AS age, "+
			"if({soon:UInt32} > 0, countDistinctIf(session_id, "+
			"timestamp < now() - INTERVAL {soon:UInt32} DAY), 0) AS expiring "+
			"FROM session_events WHERE project_id = {pid:String} FORMAT JSON",
		clickhouse.Settings{"param_pid": DefaultProjectID, "param_soon": strconv.Itoa(soon)})
	var total, age, expiring int64
	if err == nil && len(rows) > 0 {
		total = chInt(rows[0], "cnt")
		if total > 0 {
			age = chInt(rows[0], "age")
		}
		expiring = chInt(rows[0], "expiring")
	}
	return map[string]any{
		"retention_enabled":     true,
		"data_retention_days":   nilIfZero(config.DataRetentionDays),
		"score_retention_days":  nilIfZero(config.ScoreRetentionDays),
		"total_traces":          total,
		"oldest_trace_age_days": age,
		"traces_expiring_7d":    expiring,
		"next_purge_approx":     "Every 6 hours (01:30, 07:30, 13:30, 19:30 UTC)",
	}
}

// Warnings lists agents whose last completed report predates the horizon.
func (s *Store) Warnings(ctx context.Context) (map[string]any, error) {
	config := s.ReadConfig(ctx)
	if !config.Enabled || config.DataRetentionDays == 0 {
		return map[string]any{
			"warnings":          []any{},
			"retention_days":    nilIfZero(config.DataRetentionDays),
			"retention_enabled": config.Enabled,
		}, nil
	}
	rows, err := s.DB.Query(ctx,
		`SELECT a.id::text, a.name,
		 (SELECT max(completed_at) FROM insight_reports r
		  WHERE r.agent_id = a.id AND r.status = 'completed') AS last_report
		 FROM agents a`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	start := time.Now().UTC().AddDate(0, 0, -config.DataRetentionDays)
	warnings := []map[string]any{}
	for rows.Next() {
		var id string
		var name *string
		var last *time.Time
		if err := rows.Scan(&id, &name, &last); err != nil {
			return nil, err
		}
		if last == nil || last.Before(start) {
			display := "Unnamed Agent"
			if name != nil && *name != "" {
				display = *name
			}
			var lastWire any
			if last != nil {
				lastWire = wireISO(*last)
			}
			warnings = append(warnings, map[string]any{
				"agent_id":             id,
				"agent_name":           display,
				"traces_expiring_soon": 0,
				"last_insight_report":  lastWire,
			})
		}
	}
	return map[string]any{
		"warnings":          warnings,
		"retention_days":    config.DataRetentionDays,
		"retention_enabled": true,
	}, rows.Err()
}

func nilIfZero(v int) any {
	if v == 0 {
		return nil
	}
	return v
}

// wireISO matches the report timestamp rendering with a UTC offset.
func wireISO(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.999999+00:00")
}

func newEventID() string {
	return uuid.NewString()
}
