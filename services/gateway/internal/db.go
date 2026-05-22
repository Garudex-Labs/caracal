// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway PostgreSQL pool: explicit connection limits and timeouts for production resilience.

package internal

import (
	"context"
	"fmt"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/config"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	dbDefaultMaxConns        = 20
	dbDefaultMinConns        = 2
	dbDefaultConnectTimeout  = 10 * time.Second
	dbDefaultMaxConnLifetime = 30 * time.Minute
	dbDefaultMaxConnIdle     = 5 * time.Minute
	dbDefaultHealthCheck     = 30 * time.Second
)

// newPool returns a pgxpool.Pool with bounded connection counts and timeouts.
// Limits keep a single service from exhausting the shared Postgres while still
// surviving short connectivity blips through built-in health checks.
func newPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse postgres config: %w", err)
	}
	cfg.MaxConns = int32(config.IntEnv("DB_MAX_CONNS", dbDefaultMaxConns))
	cfg.MinConns = int32(config.IntEnv("DB_MIN_CONNS", dbDefaultMinConns))
	cfg.MaxConnLifetime = config.DurationEnv("DB_MAX_CONN_LIFETIME", dbDefaultMaxConnLifetime)
	cfg.MaxConnIdleTime = config.DurationEnv("DB_MAX_CONN_IDLE", dbDefaultMaxConnIdle)
	cfg.HealthCheckPeriod = config.DurationEnv("DB_HEALTH_CHECK_PERIOD", dbDefaultHealthCheck)
	cfg.ConnConfig.ConnectTimeout = config.DurationEnv("DB_CONNECT_TIMEOUT", dbDefaultConnectTimeout)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	return pool, nil
}
