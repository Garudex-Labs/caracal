// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package clickhouse

import (
	"context"
	"log/slog"
	"time"
)

const (
	maintainInterval = 4 * time.Hour
	maintainTimeout  = 2 * time.Minute
	partsWarnAt      = 300
)

// maintainedTables accumulate small parts under long-running agent sessions;
// plain OPTIMIZE (without FINAL) merges them cheaply.
var maintainedTables = []string{"session_events", "session_stats_agg"}

// Maintainer periodically compacts the busiest tables and warns when merges
// fall behind.
type Maintainer struct {
	Client *Client
}

// Run maintains the store every interval until the context ends.
func (m *Maintainer) Run(ctx context.Context) {
	ticker := time.NewTicker(maintainInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cycleCtx, cancel := context.WithTimeout(ctx, maintainTimeout)
			m.Cycle(cycleCtx)
			cancel()
		}
	}
}

// Cycle compacts each table once and checks part health.
func (m *Maintainer) Cycle(ctx context.Context) {
	for _, table := range maintainedTables {
		if err := m.Client.Exec(ctx, "OPTIMIZE TABLE "+table, nil); err != nil {
			slog.Warn("analytics store optimize failed", "table", table, "error", err)
		}
	}

	rows, err := m.Client.QueryJSON(ctx,
		"SELECT table, count() as parts, sum(rows) as total_rows "+
			"FROM system.parts WHERE database = currentDatabase() AND active "+
			"GROUP BY table FORMAT JSON", nil)
	if err != nil {
		slog.Debug("part health check failed", "error", err)
		return
	}
	for _, row := range rows {
		if parts := asInt(row["parts"]); parts > partsWarnAt {
			slog.Warn("merges may be falling behind", "table", row["table"], "parts", parts)
		}
	}
}

// asInt reads a ClickHouse count, which arrives quoted for 64-bit types.
func asInt(v any) int {
	switch value := v.(type) {
	case float64:
		return int(value)
	case string:
		n := 0
		for _, r := range value {
			if r < '0' || r > '9' {
				return 0
			}
			n = n*10 + int(r-'0')
		}
		return n
	default:
		return 0
	}
}
