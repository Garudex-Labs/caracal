// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// The readiness probe depends only on these narrow slices of each store
// client, so the concrete pool, ClickHouse client, and Redis client all
// satisfy them and the probe stays unit-testable.
type pgReadiness interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type chReadiness interface {
	Exec(ctx context.Context, sql string, settings clickhouse.Settings) error
}

type redisReadiness interface {
	Ping(ctx context.Context) *redis.StatusCmd
}

// readiness reports datastore connectivity: an unreachable relational
// store is unhealthy (503), analytics or cache outages degrade only.
func readiness(pool pgReadiness, chClient chReadiness, redisClient redisReadiness) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Each dependency gets its own timeout so one slow or unreachable
		// store cannot starve the budget of the checks that follow it and
		// make healthy dependencies look down.
		check := func(fn func(context.Context) error) error {
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			defer cancel()
			return fn(ctx)
		}

		checks := map[string]any{"status": "ok"}
		var userCount int64
		if err := check(func(ctx context.Context) error {
			return pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&userCount)
		}); err != nil {
			checks["postgres"] = "unreachable"
			checks["status"] = "unhealthy"
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(checks)
			return
		}
		checks["postgres"] = "ok"
		checks["initialized"] = userCount > 0

		if err := check(func(ctx context.Context) error {
			return chClient.Exec(ctx, "SELECT 1", nil)
		}); err != nil {
			checks["clickhouse"] = "unreachable"
			checks["status"] = "degraded"
		} else {
			checks["clickhouse"] = "ok"
		}

		if err := check(func(ctx context.Context) error {
			return redisClient.Ping(ctx).Err()
		}); err != nil {
			checks["redis"] = "unreachable"
			checks["status"] = "degraded"
		} else {
			checks["redis"] = "ok"
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(checks)
	}
}
