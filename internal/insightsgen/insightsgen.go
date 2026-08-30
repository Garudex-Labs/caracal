// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package insightsgen generates agent insight reports: deterministic
// metadata extraction from raw session JSONL, model-assisted facet
// extraction, parallel narrative sections, registry reuse matching, and
// the background runner and schedulers that drive report rows through
// their lifecycle.
package insightsgen

import (
	"context"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/fernet"
	"github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/settings"
)

// DefaultProjectID scopes analytics rows during the single-project phase.
const DefaultProjectID = "default"

// legacyUnversioned matches telemetry ingested before versions existed;
// those rows belong to the first published version.
const legacyUnversioned = "1.0.0"

// PGQuerier is the subset of a pgx pool the engine needs.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// CHQuerier runs analytics-store reads.
type CHQuerier interface {
	QueryJSON(ctx context.Context, sql string, settings clickhouse.Settings) ([]map[string]any, error)
}

// Config resolves the runtime insight settings, decrypting values stored
// with the at-rest encryption prefix. Resolved secrets are never logged.
type Config struct {
	Settings settings.Reader
	// SecretKey is the derived at-rest encryption key; nil leaves encrypted
	// values unreadable, which callers treat as unset.
	SecretKey []byte
}

const encPrefix = "enc:"

// String reads a plain setting.
func (c *Config) String(ctx context.Context, key, fallback string) string {
	if c == nil || c.Settings == nil {
		return fallback
	}
	return c.Settings.String(ctx, key, fallback)
}

// Bool reads a boolean setting.
func (c *Config) Bool(ctx context.Context, key string, fallback bool) bool {
	if c == nil || c.Settings == nil {
		return fallback
	}
	return c.Settings.Bool(ctx, key, fallback)
}

// Int reads an integer setting.
func (c *Config) Int(ctx context.Context, key string, fallback int) int {
	if c == nil || c.Settings == nil {
		return fallback
	}
	return c.Settings.Int(ctx, key, fallback)
}

// Secret reads a setting that may be stored encrypted at rest.
func (c *Config) Secret(ctx context.Context, key string) string {
	raw := c.String(ctx, key, "")
	if !strings.HasPrefix(raw, encPrefix) {
		return raw
	}
	if len(c.SecretKey) == 0 {
		return ""
	}
	plain, err := fernet.Decrypt(c.SecretKey, strings.TrimPrefix(raw, encPrefix))
	if err != nil {
		return ""
	}
	return string(plain)
}

// Engine holds the dependencies of the report generation pipeline.
type Engine struct {
	DB      PGQuerier
	CH      CHQuerier
	Config  *Config
	Catalog *registry.Store
	LLM     Completer

	// checkCredentials is the AWS credential probe, replaceable in tests.
	checkCredentials func(ctx context.Context, region, accessKey, secretKey string) error
}

// versionFilter renders the version-scoped telemetry predicate. Telemetry
// ingested before versions existed belongs to the first published version.
func versionFilter(column string, nullable bool) string {
	expr := column
	if nullable {
		expr = "coalesce(" + column + ", '')"
	}
	return "({agent_version:String} = '' OR " + expr + " = {agent_version:String} " +
		"OR ({agent_version:String} = '" + legacyUnversioned + "' AND " + expr + " = ''))"
}

func chString(row map[string]any, key string) string {
	s, _ := row[key].(string)
	return s
}

func chFloat(row map[string]any, key string) float64 {
	switch v := row[key].(type) {
	case float64:
		return v
	case string:
		f, _ := strconv.ParseFloat(v, 64)
		return f
	}
	return 0
}

func chInt(row map[string]any, key string) int {
	return int(chFloat(row, key))
}
