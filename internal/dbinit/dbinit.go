// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package dbinit prepares the PostgreSQL and ClickHouse schemas before the
// API starts. It applies the embedded versioned migrations exactly once,
// tracks the PostgreSQL schema version in the alembic_version table and the
// ClickHouse versions in clickhouse_schema_migrations, and is safe to run
// concurrently and repeatedly.
package dbinit

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strings"
)

//go:embed migrations/postgres/*.sql migrations/clickhouse/*.sql
var migrationsFS embed.FS

type migrationFile struct {
	Version string
	Name    string
	SQL     string
}

// loadMigrations returns the embedded migrations for one engine sorted by
// version prefix.
func loadMigrations(engine string) ([]migrationFile, error) {
	entries, err := fs.ReadDir(migrationsFS, "migrations/"+engine)
	if err != nil {
		return nil, fmt.Errorf("read %s migrations: %w", engine, err)
	}
	files := make([]migrationFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		data, err := migrationsFS.ReadFile("migrations/" + engine + "/" + entry.Name())
		if err != nil {
			return nil, err
		}
		files = append(files, migrationFile{
			Version: strings.TrimSuffix(entry.Name(), ".sql"),
			Name:    entry.Name(),
			SQL:     string(data),
		})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Version < files[j].Version })
	return files, nil
}

// Run applies pending PostgreSQL migrations and then pending ClickHouse
// migrations. Either URL may be empty to skip that engine. When PostgreSQL
// is configured, a session advisory lock serializes the whole run across
// concurrent init processes, covering the ClickHouse phase too.
func Run(ctx context.Context, postgresURL, clickhouseURL string) error {
	var unlock func()
	if postgresURL != "" {
		slog.Info("applying postgres migrations")
		released, err := runPostgres(ctx, postgresURL)
		if err != nil {
			return fmt.Errorf("postgres migrations: %w", err)
		}
		unlock = released
		defer unlock()
	}
	if clickhouseURL != "" {
		slog.Info("applying clickhouse migrations")
		if err := runClickHouse(ctx, clickhouseURL); err != nil {
			return fmt.Errorf("clickhouse migrations: %w", err)
		}
	}
	slog.Info("database initialization complete")
	return nil
}
