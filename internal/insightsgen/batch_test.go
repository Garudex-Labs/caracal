// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

func TestCountAgentSessionsPrefersAggregate(t *testing.T) {
	ch := &fakeCH{fn: func(call int, sql string, settings clickhouse.Settings) ([]map[string]any, error) {
		if settings["param_agent_id"] != "aid" || settings["param_agent_version"] != "1.2.0" {
			return nil, errors.New("missing query params")
		}
		return []map[string]any{{"cnt": "7"}}, nil
	}}
	e := &Engine{CH: ch}
	got := e.countAgentSessions(context.Background(), "aid", "aname", "2026-01-01 00:00:00", "1.2.0")
	if got != 7 {
		t.Errorf("count = %d", got)
	}
	if ch.calls != 1 || !strings.Contains(ch.sqls[0], "session_stats_agg") {
		t.Errorf("aggregate path must issue one aggregate query, calls = %d", ch.calls)
	}
}

func TestCountAgentSessionsFallsBackToEvents(t *testing.T) {
	ch := &fakeCH{fn: func(call int, sql string, _ clickhouse.Settings) ([]map[string]any, error) {
		if call == 1 {
			return nil, errors.New("aggregate down")
		}
		return []map[string]any{{"cnt": float64(3)}}, nil
	}}
	e := &Engine{CH: ch}
	got := e.countAgentSessions(context.Background(), "aid", "aname", "since", "")
	if got != 3 {
		t.Errorf("fallback count = %d", got)
	}
	if ch.calls != 2 || !strings.Contains(ch.sqls[1], "session_events") {
		t.Errorf("fallback must query session_events, calls = %d", ch.calls)
	}
}

func TestCountAgentSessionsEmptyAggregateStillFallsBack(t *testing.T) {
	ch := &fakeCH{fn: func(call int, _ string, _ clickhouse.Settings) ([]map[string]any, error) {
		if call == 1 {
			return []map[string]any{}, nil
		}
		return []map[string]any{{"cnt": "5"}}, nil
	}}
	e := &Engine{CH: ch}
	if got := e.countAgentSessions(context.Background(), "aid", "aname", "since", ""); got != 5 {
		t.Errorf("count = %d", got)
	}
	if ch.calls != 2 {
		t.Errorf("empty aggregate rows must fall through, calls = %d", ch.calls)
	}
}

func TestCountAgentSessionsBothPathsFail(t *testing.T) {
	ch := &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, errors.New("down")
	}}
	e := &Engine{CH: ch}
	if got := e.countAgentSessions(context.Background(), "aid", "aname", "since", ""); got != 0 {
		t.Errorf("count = %d, want 0", got)
	}
}

func TestCountAgentSessionsFallbackNoRows(t *testing.T) {
	ch := &fakeCH{fn: func(call int, _ string, _ clickhouse.Settings) ([]map[string]any, error) {
		if call == 1 {
			return nil, errors.New("aggregate down")
		}
		return []map[string]any{}, nil
	}}
	e := &Engine{CH: ch}
	if got := e.countAgentSessions(context.Background(), "aid", "aname", "since", ""); got != 0 {
		t.Errorf("count = %d, want 0", got)
	}
}
