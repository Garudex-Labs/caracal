// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"errors"
	"testing"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// batchService wires a Service for discovery tests; the CH fake answers
// the session-count aggregate with the given count.
func batchService(db *fakeDB, sessionCount float64) *Service {
	ch := &fakeCH{fn: func(_ int, _ string, _ clickhouse.Settings) ([]map[string]any, error) {
		return []map[string]any{{"cnt": sessionCount}}, nil
	}}
	engine := &Engine{DB: db, CH: ch, Config: &Config{Settings: fakeSettings{}}, LLM: &recordingCompleter{}}
	return NewService(engine, &Store{DB: db}, 1)
}

func agentListStub() stub {
	return stub{match: "JOIN agent_versions v ON a.latest_version_id", rows: &fakeRows{rows: [][]any{
		{testAgentID, "Review Bot", testVersionID, "1.2.0"},
	}}}
}

func TestDiscoverAndQueueCreatesReport(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		agentListStub(),
		{match: "SELECT count(*) FROM insight_reports", rows: &fakeRows{rows: [][]any{{0}}}},
		{match: "ORDER BY created_at DESC LIMIT 1", rows: &fakeRows{rows: [][]any{{"prev-report"}}}},
		{match: "INSERT INTO insight_reports", rows: &fakeRows{rows: [][]any{{testReportID}}}},
	}}
	s := batchService(db, 12)
	queued, err := s.DiscoverAndQueue(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Errorf("queued = %d", queued)
	}
	inserts := db.sqlCalls("INSERT INTO insight_reports")
	if len(inserts) != 1 {
		t.Fatalf("inserts = %d", len(inserts))
	}
	// The previous completed report for the version links in.
	if prev := *(inserts[0].args[3].(*string)); prev != "prev-report" {
		t.Errorf("previous_report_id = %q", prev)
	}
	if inserts[0].args[4] != testVersionID || inserts[0].args[5] != "1.2.0" {
		t.Errorf("version pin: %v", inserts[0].args)
	}
}

func TestDiscoverAndQueueSkipsRecentlyReported(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		agentListStub(),
		{match: "SELECT count(*) FROM insight_reports", rows: &fakeRows{rows: [][]any{{1}}}},
	}}
	s := batchService(db, 12)
	queued, err := s.DiscoverAndQueue(context.Background())
	if err != nil || queued != 0 {
		t.Errorf("queued = %d, err = %v", queued, err)
	}
	if got := db.sqlCalls("INSERT INTO insight_reports"); len(got) != 0 {
		t.Errorf("recent report must suppress a new row: %d", len(got))
	}
}

func TestDiscoverAndQueueSkipsQuietAgents(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		agentListStub(),
		{match: "SELECT count(*) FROM insight_reports", rows: &fakeRows{rows: [][]any{{0}}}},
	}}
	s := batchService(db, 2) // below the default minimum of 5
	queued, err := s.DiscoverAndQueue(context.Background())
	if err != nil || queued != 0 {
		t.Errorf("queued = %d, err = %v", queued, err)
	}
}

func TestDiscoverAndQueueDisabled(t *testing.T) {
	db := &fakeDB{}
	ch := &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) { return nil, nil }}
	engine := &Engine{DB: db, CH: ch,
		Config: &Config{Settings: cfgMap{bools: map[string]bool{"insights.batch_enabled": false}}}}
	s := NewService(engine, &Store{DB: db}, 1)
	queued, err := s.DiscoverAndQueue(context.Background())
	if err != nil || queued != 0 {
		t.Errorf("queued = %d, err = %v", queued, err)
	}
}

func TestDiscoverAndQueueAgentListFailure(t *testing.T) {
	db := &fakeDB{queryErr: map[string]error{"JOIN agent_versions v": errors.New("db down")}}
	s := batchService(db, 12)
	if _, err := s.DiscoverAndQueue(context.Background()); err == nil {
		t.Error("agent list failure must surface")
	}
}

func TestDiscoverAndQueueNoAgents(t *testing.T) {
	s := batchService(&fakeDB{}, 12)
	queued, err := s.DiscoverAndQueue(context.Background())
	if err != nil || queued != 0 {
		t.Errorf("queued = %d, err = %v", queued, err)
	}
}

func TestDiscoverAndQueueAgentFailureContinues(t *testing.T) {
	// The recent-report count query fails: that agent is skipped, the
	// sweep itself succeeds.
	db := &fakeDB{
		stubs:    []stub{agentListStub()},
		queryErr: map[string]error{"SELECT count(*) FROM insight_reports": errors.New("flaky")},
	}
	s := batchService(db, 12)
	queued, err := s.DiscoverAndQueue(context.Background())
	if err != nil || queued != 0 {
		t.Errorf("queued = %d, err = %v", queued, err)
	}
}
