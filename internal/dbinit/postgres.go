// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package dbinit

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
)

// initLockKey serializes schema initialization across concurrent processes.
const initLockKey int64 = 0x6361726163616C31 // "caracal1"

// runPostgres brings the schema to the latest embedded version. The
// alembic_version table carries the single current version; unknown
// versions abort with recreate guidance because pre-baseline databases
// cannot be upgraded in place. On success the returned func releases the
// session advisory lock (and connection) so callers can extend the
// critical section over later phases.
func runPostgres(ctx context.Context, rawURL string) (func(), error) {
	dsn := strings.Replace(rawURL, "postgresql+asyncpg://", "postgresql://", 1)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	release := func() { _ = conn.Close(context.Background()) }
	failed := true
	defer func() {
		if failed {
			release()
		}
	}()

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", initLockKey); err != nil {
		return nil, fmt.Errorf("acquire init lock: %w", err)
	}

	migrations, err := loadMigrations("postgres")
	if err != nil {
		return nil, err
	}
	if len(migrations) == 0 {
		return nil, errors.New("no embedded postgres migrations")
	}

	current, err := currentPGVersion(ctx, conn)
	if err != nil {
		return nil, err
	}

	startIdx := 0
	if current != "" {
		known := -1
		for i, m := range migrations {
			if m.Version == current {
				known = i
				break
			}
		}
		if known < 0 {
			return nil, fmt.Errorf("database schema version %q is not recognized; "+
				"it cannot be upgraded in place and the database must be recreated from scratch", current)
		}
		startIdx = known + 1
	}

	for _, m := range migrations[startIdx:] {
		slog.Info("applying postgres migration", "version", m.Version)
		if err := applyPGScript(ctx, conn, m.SQL); err != nil {
			return nil, fmt.Errorf("apply %s: %w", m.Name, err)
		}
		if err := stampPGVersion(ctx, conn, m.Version); err != nil {
			return nil, fmt.Errorf("record %s: %w", m.Name, err)
		}
	}
	if startIdx >= len(migrations) {
		slog.Info("postgres schema up to date", "version", current)
	}
	failed = false
	return release, nil
}

// currentPGVersion returns the recorded schema version, or "" for a fresh
// database.
func currentPGVersion(ctx context.Context, conn *pgx.Conn) (string, error) {
	var exists bool
	err := conn.QueryRow(ctx, "SELECT to_regclass('public.alembic_version') IS NOT NULL").Scan(&exists)
	if err != nil {
		return "", fmt.Errorf("inspect version table: %w", err)
	}
	if !exists {
		return "", nil
	}
	var version string
	err = conn.QueryRow(ctx, "SELECT version_num FROM public.alembic_version LIMIT 1").Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read schema version: %w", err)
	}
	return version, nil
}

// applyPGScript runs a multi-statement migration script in one transaction.
func applyPGScript(ctx context.Context, conn *pgx.Conn, script string) error {
	results := conn.PgConn().Exec(ctx, "BEGIN;\n"+script+"\nCOMMIT;")
	_, err := results.ReadAll()
	if err != nil {
		_ = results.Close()
		return err
	}
	return results.Close()
}

// stampPGVersion records the current schema version as the single row of
// alembic_version.
func stampPGVersion(ctx context.Context, conn *pgx.Conn, version string) error {
	batch := []string{
		"CREATE TABLE IF NOT EXISTS public.alembic_version (version_num VARCHAR(32) NOT NULL, " +
			"CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))",
		"DELETE FROM public.alembic_version",
	}
	for _, stmt := range batch {
		if _, err := conn.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	_, err := conn.Exec(ctx, "INSERT INTO public.alembic_version (version_num) VALUES ($1)", version)
	return err
}
