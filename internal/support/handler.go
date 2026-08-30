// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package support serves the diagnostic-collection endpoint used by
// support bundles. Each collector runs concurrently under a ten-second
// timeout; partial failures are reported per collector and the endpoint
// answers 200 whenever it can run at all.
package support

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/logring"
	"github.com/garudex-labs/caracal/internal/redact"
)

const collectorTimeout = 10 * time.Second

// safeTableName guards identifier interpolation for count queries.
var safeTableName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// PGQuerier is the subset of a pgx pool the collectors need.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// SettingsReader answers dynamic configuration lookups.
type SettingsReader interface {
	String(ctx context.Context, key, fallback string) string
}

// Handler serves the support collection group.
type Handler struct {
	DB       PGQuerier
	CH       *clickhouse.Client
	Redis    redis.UniversalClient
	Settings SettingsReader
	Ring     *logring.Ring
	Version  string
	// Connection URLs reported by the config collector.
	PostgresURL   string
	ClickHouseURL string
	RedisURL      string

	mu     sync.Mutex
	visits map[string][]time.Time
}

// Routes mounts the group; run it behind the administrator floor.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/support/collect", h.collect)
	return mux
}

// allow applies the five-per-minute window per actor.
func (h *Handler) allow(actor string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.visits == nil {
		h.visits = map[string][]time.Time{}
	}
	cutoff := time.Now().Add(-time.Minute)
	kept := h.visits[actor][:0]
	for _, t := range h.visits[actor] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= 5 {
		h.visits[actor] = kept
		return false
	}
	h.visits[actor] = append(kept, time.Now())
	return true
}

type collectorData struct {
	OK         bool    `json:"ok"`
	DurationMS int64   `json:"duration_ms"`
	Data       any     `json:"data"`
	Error      *string `json:"error"`
}

func okData(start time.Time, data any) collectorData {
	return collectorData{OK: true, DurationMS: time.Since(start).Milliseconds(), Data: data}
}

func errData(start time.Time, msg string) collectorData {
	m := msg
	return collectorData{OK: false, DurationMS: time.Since(start).Milliseconds(), Error: &m}
}

func (h *Handler) collect(w http.ResponseWriter, r *http.Request) {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	if !h.allow(claims.UserID.String()) {
		httpapi.WriteJSON(w, http.StatusTooManyRequests,
			map[string]string{"error": "Rate limit exceeded: 5 per 1 minute"})
		return
	}
	var body struct {
		Collectors []string `json:"collectors"`
		LogsSince  string   `json:"logs_since"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if len(body.Collectors) == 0 {
		body.Collectors = []string{"all"}
	}
	if body.LogsSince == "" {
		body.LogsSince = "1h"
	}

	type collectorFn func(ctx context.Context) any
	registry := map[string]collectorFn{
		"versions":   func(ctx context.Context) any { return h.collectVersions(ctx) },
		"health":     func(ctx context.Context) any { return h.collectHealth(ctx) },
		"config":     func(ctx context.Context) any { return h.collectConfig(ctx) },
		"aggregates": func(ctx context.Context) any { return h.collectAggregates(ctx) },
		"errors":     func(ctx context.Context) any { return map[string]any{"fingerprints": []any{}} },
		"logs":       func(ctx context.Context) any { return h.collectLogs(body.LogsSince) },
	}
	order := []string{"versions", "health", "config", "aggregates", "errors", "logs"}

	requested := order
	if !contains(body.Collectors, "all") {
		requested = nil
		for _, name := range order {
			if contains(body.Collectors, name) {
				requested = append(requested, name)
			}
		}
	}

	results := make(map[string]collectorData, len(requested))
	var wg sync.WaitGroup
	var resMu sync.Mutex
	for _, name := range requested {
		wg.Add(1)
		go func(name string, fn collectorFn) {
			defer wg.Done()
			start := time.Now()
			ctx, cancel := context.WithTimeout(r.Context(), collectorTimeout)
			defer cancel()
			done := make(chan any, 1)
			go func() {
				defer func() {
					if rec := recover(); rec != nil {
						done <- errData(start, "PanicError")
					}
				}()
				done <- fn(ctx)
			}()
			var out collectorData
			select {
			case v := <-done:
				if cd, isCD := v.(collectorData); isCD {
					out = cd
				} else {
					out = okData(start, v)
				}
			case <-ctx.Done():
				msg := fmt.Sprintf("Collector timed out after %ds", int(collectorTimeout.Seconds()))
				out = collectorData{OK: false, DurationMS: collectorTimeout.Milliseconds(), Error: &msg}
			}
			resMu.Lock()
			results[name] = out
			resMu.Unlock()
		}(name, registry[name])
	}
	wg.Wait()

	version := h.Version
	if version == "" {
		version = "0.1.0"
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"server_version": version,
		"collectors":     results,
	})
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func (h *Handler) collectVersions(ctx context.Context) map[string]any {
	result := map[string]any{}
	version := h.Version
	if version == "" {
		version = "0.1.0"
	}
	result["app_version"] = version
	buildHash := os.Getenv("BUILD_HASH")
	if buildHash == "" {
		buildHash = "unknown"
	}
	result["build_hash"] = buildHash

	var rev string
	if err := h.DB.QueryRow(ctx, `SELECT version_num FROM alembic_version LIMIT 1`).Scan(&rev); err != nil || rev == "" {
		if errors.Is(err, pgx.ErrNoRows) || rev == "" {
			result["alembic_revision"] = "unknown"
		} else {
			result["alembic_revision"] = "error: QueryError"
		}
	} else {
		result["alembic_revision"] = rev
	}

	if rows, err := h.CH.QueryJSON(ctx, "SELECT version() AS v FORMAT JSON", nil); err == nil && len(rows) > 0 {
		result["clickhouse_version"], _ = rows[0]["v"].(string)
	} else {
		result["clickhouse_version"] = "error: QueryError"
	}

	tables, err := h.chTableNames(ctx)
	if err != nil {
		result["clickhouse_tables"] = []string{}
	} else {
		result["clickhouse_tables"] = tables
	}
	return result
}

func (h *Handler) chTableNames(ctx context.Context) ([]string, error) {
	rows, err := h.CH.QueryJSON(ctx,
		"SELECT name FROM system.tables WHERE database = {db:String} FORMAT JSON",
		clickhouse.Settings{"param_db": h.CH.Database()})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(rows))
	for _, r := range rows {
		if name, isStr := r["name"].(string); isStr {
			names = append(names, name)
		}
	}
	return names, nil
}

func (h *Handler) collectHealth(ctx context.Context) map[string]any {
	result := map[string]any{}

	pgStart := time.Now()
	var one int
	if err := h.DB.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil {
		result["postgres"] = map[string]any{
			"status": "error", "latency_ms": time.Since(pgStart).Milliseconds(), "error": "QueryError",
		}
	} else {
		result["postgres"] = map[string]any{"status": "ok", "latency_ms": time.Since(pgStart).Milliseconds()}
	}

	chStart := time.Now()
	if _, err := h.CH.QueryJSON(ctx, "SELECT 1 AS one FORMAT JSON", nil); err != nil {
		result["clickhouse"] = map[string]any{
			"status": "error", "latency_ms": time.Since(chStart).Milliseconds(), "error": "QueryError",
		}
	} else {
		result["clickhouse"] = map[string]any{"status": "ok", "latency_ms": time.Since(chStart).Milliseconds()}
	}

	redisStart := time.Now()
	if err := h.Redis.Ping(ctx).Err(); err != nil {
		result["redis"] = map[string]any{
			"status": "error", "latency_ms": time.Since(redisStart).Milliseconds(), "error": "PingError",
		}
	} else {
		result["redis"] = map[string]any{"status": "ok", "latency_ms": time.Since(redisStart).Milliseconds()}
	}
	return result
}

// dynamicConfigKeys are the runtime settings reported in the bundle.
var dynamicConfigKeys = []struct {
	key      string
	fallback string
}{
	{"eval.model_name", ""},
	{"eval.model_provider", ""},
	{"eval.aws_region", ""},
	{"deployment.frontend_url", "http://localhost:8000"},
	{"data.retention_days", "90"},
}

func (h *Handler) collectConfig(ctx context.Context) map[string]any {
	result := map[string]any{
		"DATABASE_URL":          h.PostgresURL,
		"CLICKHOUSE_URL":        h.ClickHouseURL,
		"REDIS_URL":             h.RedisURL,
		"JWT_SIGNING_ALGORITHM": "ES256",
	}
	for _, entry := range dynamicConfigKeys {
		result[entry.key] = h.Settings.String(ctx, entry.key, entry.fallback)
	}
	// Retained for older support bundle readers. All features are enabled.
	result["licensed"] = true
	return result
}

func (h *Handler) collectAggregates(ctx context.Context) map[string]any {
	result := map[string]any{}

	pgCounts := map[string]any{}
	rows, err := h.DB.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)
	if err != nil {
		result["pg_table_counts"] = map[string]any{"error": "QueryError"}
	} else {
		var names []string
		for rows.Next() {
			var name string
			if rows.Scan(&name) == nil {
				names = append(names, name)
			}
		}
		rows.Close()
		for _, name := range names {
			if !safeTableName.MatchString(name) {
				pgCounts[name] = "error: unsafe table name, skipped"
				continue
			}
			var count int64
			if err := h.DB.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM %q`, name)).Scan(&count); err != nil {
				pgCounts[name] = "error: QueryError"
			} else {
				pgCounts[name] = count
			}
		}
		result["pg_table_counts"] = pgCounts
	}

	chCounts := map[string]any{}
	tables, err := h.chTableNames(ctx)
	if err != nil {
		result["ch_table_counts"] = map[string]any{"error": "QueryError"}
		return result
	}
	for _, name := range tables {
		if !safeTableName.MatchString(name) {
			chCounts[name] = "error: unsafe table name, skipped"
			continue
		}
		countRows, err := h.CH.QueryJSON(ctx,
			fmt.Sprintf("SELECT count() AS cnt FROM `%s` FORMAT JSON", name), nil)
		if err != nil || len(countRows) == 0 {
			if err != nil {
				chCounts[name] = "error: QueryError"
			} else {
				chCounts[name] = 0
			}
			continue
		}
		chCounts[name] = chNumber(countRows[0]["cnt"])
	}
	result["ch_table_counts"] = chCounts
	return result
}

// chNumber normalizes the store's string-quoted 64-bit integers.
func chNumber(v any) any {
	if s, isStr := v.(string); isStr {
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return n
		}
	}
	return v
}

// durationPattern parses "1h", "30m", "2d", "1h30m", "90s".
var durationPattern = regexp.MustCompile(`(?i)(\d+)\s*([dhms])`)

func parseDuration(raw string) time.Duration {
	matches := durationPattern.FindAllStringSubmatch(raw, -1)
	if len(matches) == 0 {
		return time.Hour
	}
	var total time.Duration
	for _, m := range matches {
		n, _ := strconv.ParseInt(m[1], 10, 64)
		switch strings.ToLower(m[2]) {
		case "d":
			total += time.Duration(n) * 24 * time.Hour
		case "h":
			total += time.Duration(n) * time.Hour
		case "m":
			total += time.Duration(n) * time.Minute
		case "s":
			total += time.Duration(n) * time.Second
		}
	}
	if total <= 0 {
		return time.Hour
	}
	return total
}

func (h *Handler) collectLogs(logsSince string) map[string]any {
	cutoff := time.Now().UTC().Add(-parseDuration(logsSince))
	entries := h.Ring.Snapshot()
	lines := []map[string]any{}
	for _, e := range entries {
		ts, err := time.Parse(time.RFC3339Nano, e.Timestamp)
		if err != nil || ts.Before(cutoff) {
			continue
		}
		lines = append(lines, map[string]any{
			"timestamp":   e.Timestamp,
			"level":       e.Level,
			"event":       redact.Secrets(e.Event),
			"logger_name": e.LoggerName,
			"function":    e.Function,
			"line":        e.Line,
		})
	}
	if len(lines) == 0 {
		return map[string]any{
			"lines": lines,
			"note":  "Log buffer empty or server recently restarted",
		}
	}
	return map[string]any{"lines": lines}
}
