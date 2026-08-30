// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package dbinit

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"strings"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

const chMigrationsTable = "clickhouse_schema_migrations"

// runClickHouse ensures the database exists and applies pending versioned
// statements, recording each applied file in clickhouse_schema_migrations.
func runClickHouse(ctx context.Context, rawURL string) error {
	client, err := clickhouse.New(rawURL, nil)
	if err != nil {
		return err
	}
	if err := ensureCHDatabase(ctx, rawURL, client.Database()); err != nil {
		return err
	}
	if err := client.Exec(ctx, "SELECT 1", nil); err != nil {
		return fmt.Errorf("clickhouse unreachable: %w", err)
	}
	if err := client.Exec(ctx, fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s (
		version String,
		name String,
		applied_at DateTime64(3, 'UTC') DEFAULT now()
	) ENGINE = MergeTree()
	ORDER BY version`, chMigrationsTable), nil); err != nil {
		return fmt.Errorf("migration table setup: %w", err)
	}

	applied, err := appliedCHVersions(ctx, client)
	if err != nil {
		return err
	}
	migrations, err := loadMigrations("clickhouse")
	if err != nil {
		return err
	}
	for _, m := range migrations {
		if applied[m.Version] {
			continue
		}
		statements := splitSQL(m.SQL)
		slog.Info("applying clickhouse migration", "name", m.Name, "statements", len(statements))
		for _, stmt := range statements {
			if err := client.Exec(ctx, stmt, clickhouse.Settings{"wait_for_async_insert": "1"}); err != nil {
				return fmt.Errorf("migration %s: %w", m.Name, err)
			}
		}
		if err := client.Exec(ctx,
			fmt.Sprintf("INSERT INTO %s (version, name) VALUES ({version:String}, {name:String})", chMigrationsTable),
			clickhouse.Settings{
				"param_version":         m.Version,
				"param_name":            m.Name,
				"wait_for_async_insert": "1",
			}); err != nil {
			return fmt.Errorf("record %s: %w", m.Name, err)
		}
	}
	return nil
}

// ensureCHDatabase creates the target database through a default-bound
// connection, since queries against a missing database fail outright.
func ensureCHDatabase(ctx context.Context, rawURL, database string) error {
	parsed, err := url.Parse(strings.Replace(rawURL, "clickhouse://", "http://", 1))
	if err != nil {
		return err
	}
	parsed.Path = "/default"
	server, err := clickhouse.New(parsed.String(), nil)
	if err != nil {
		return err
	}
	if err := server.Exec(ctx, "CREATE DATABASE IF NOT EXISTS "+quoteCHIdentifier(database), nil); err != nil {
		return fmt.Errorf("database setup: %w", err)
	}
	return nil
}

func quoteCHIdentifier(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "") + "`"
}

// appliedCHVersions reads the recorded migration versions.
func appliedCHVersions(ctx context.Context, client *clickhouse.Client) (map[string]bool, error) {
	rows, err := client.QueryJSON(ctx, "SELECT version FROM "+chMigrationsTable+" FORMAT JSON", nil)
	if err != nil {
		return nil, fmt.Errorf("migration lookup: %w", err)
	}
	applied := make(map[string]bool, len(rows))
	for _, row := range rows {
		if version, ok := row["version"].(string); ok {
			applied[version] = true
		}
	}
	return applied, nil
}

// splitSQL splits a migration file into executable statements, honoring
// quoted strings, backslash escapes, and comment lines.
func splitSQL(sql string) []string {
	var kept []string
	for _, line := range strings.Split(sql, "\n") {
		trimmed := strings.TrimLeft(line, " \t")
		if strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "--") {
			continue
		}
		kept = append(kept, line)
	}
	stripped := strings.Join(kept, "\n")

	statements := []string{}
	var current strings.Builder
	var quote byte
	escaped := false
	for i := 0; i < len(stripped); i++ {
		char := stripped[i]
		current.WriteByte(char)
		if quote != 0 {
			switch {
			case escaped:
				escaped = false
			case char == '\\':
				escaped = true
			case char == quote:
				quote = 0
			}
			continue
		}
		if char == '\'' || char == '"' {
			quote = char
			continue
		}
		if char == ';' {
			stmt := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(current.String()), ";"))
			if stmt != "" {
				statements = append(statements, stmt)
			}
			current.Reset()
		}
	}
	if tail := strings.TrimSpace(current.String()); tail != "" {
		statements = append(statements, tail)
	}
	return statements
}
