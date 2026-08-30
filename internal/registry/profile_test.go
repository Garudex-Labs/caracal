// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// fakeCH routes analytics queries to canned rows by SQL substring.
type fakeCH struct {
	stubs []struct {
		match string
		rows  []map[string]any
		err   error
	}
	log []string
}

func (c *fakeCH) add(match string, rows []map[string]any, err error) {
	c.stubs = append(c.stubs, struct {
		match string
		rows  []map[string]any
		err   error
	}{match, rows, err})
}

func (c *fakeCH) QueryJSON(_ context.Context, sql string, _ clickhouse.Settings) ([]map[string]any, error) {
	c.log = append(c.log, sql)
	for _, s := range c.stubs {
		if strings.Contains(sql, s.match) {
			return s.rows, s.err
		}
	}
	return nil, nil
}

func TestBuildSignalQueryDeduplicates(t *testing.T) {
	got := buildSignalQuery([]string{"go", "Postgres"}, []string{"postgres", " ", "redis"})
	if got != "go Postgres redis" {
		t.Errorf("query = %q", got)
	}
	if buildSignalQuery(nil, []string{}) != "" {
		t.Errorf("empty parts must yield empty query")
	}
}

func TestCounterMostCommonPreservesFirstSeenOrderOnTies(t *testing.T) {
	c := newCounter()
	c.add("beta", 1)
	c.add("alpha", 1)
	c.add("gamma", 2)
	got := c.mostCommon(2)
	if len(got) != 2 || got[0] != "gamma" || got[1] != "beta" {
		t.Errorf("mostCommon = %v", got)
	}
	if keys := c.keys(); len(keys) != 3 || keys[0] != "beta" {
		t.Errorf("keys = %v", keys)
	}
}

func TestIDArrayRejectsUnsafeIDs(t *testing.T) {
	got := idArray([]string{"abc-123", "bad'id", "x.y:z"})
	if got != "['abc-123','x.y:z']" {
		t.Errorf("idArray = %q", got)
	}
	many := make([]string, 200)
	for i := range many {
		many[i] = "s"
	}
	if n := strings.Count(idArray(many), "'s'"); n != maxIDArray {
		t.Errorf("cap = %d entries, want %d", n, maxIDArray)
	}
}

func TestMcpServerName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"mcp__github__create_issue", "github"},
		{"mcp__linear", "linear"},
		{"Bash", ""},
	}
	for _, c := range cases {
		if got := mcpServerName(c.in); got != c.want {
			t.Errorf("mcpServerName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestChScalars(t *testing.T) {
	row := map[string]any{"s": "x", "f": float64(4), "n": "7", "bad": []any{}}
	if chString(row, "s") != "x" || chString(row, "missing") != "" {
		t.Errorf("chString misread")
	}
	if chInt(row, "f") != 4 || chInt(row, "n") != 7 || chInt(row, "bad") != 0 {
		t.Errorf("chInt misread")
	}
}

func TestWorkProfileEmptinessAndSignals(t *testing.T) {
	empty := WorkProfile{}
	if !empty.isEmpty() {
		t.Errorf("zero profile must be empty")
	}
	tools := make([]string, 15)
	for i := range tools {
		tools[i] = "tool" + string(rune('a'+i))
	}
	p := WorkProfile{Topics: []string{"databases"}, Tools: tools}
	if p.isEmpty() {
		t.Errorf("profile with topics is not empty")
	}
	signals := p.searchSignals()
	if !strings.HasPrefix(signals, "databases") {
		t.Errorf("signals = %q", signals)
	}
	// Tools trim to ten in the signal string.
	if strings.Contains(signals, "toolk") {
		t.Errorf("tools not trimmed: %q", signals)
	}
}

func TestBuildProfileMinesSessionMetadata(t *testing.T) {
	ch := &fakeCH{}
	ch.add("FROM session_stats_agg", []map[string]any{
		{"session_id": "s1", "harness": "kiro"},
		{"session_id": "s2", "harness": "kiro"},
	}, nil)
	ch.add("tool_name", []map[string]any{
		{"tool_name": "mcp__github__create_issue", "uses": float64(9)},
		{"tool_name": "Bash", "uses": float64(4)},
	}, nil)
	ch.add("content_preview", []map[string]any{
		{"content_preview": "edited main.py and app.py"},
	}, nil)
	s := &Store{CH: ch}
	profile, err := s.BuildProfile(context.Background(), uuid.MustParse(testViewerID), "default")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if profile.SessionCount != 2 {
		t.Errorf("sessions = %d", profile.SessionCount)
	}
	if len(profile.Harnesses) != 1 || profile.Harnesses[0] != "kiro" {
		t.Errorf("harnesses = %v", profile.Harnesses)
	}
	if len(profile.McpServers) != 1 || profile.McpServers[0] != "github" {
		t.Errorf("mcp servers = %v", profile.McpServers)
	}
	if len(profile.Tools) != 1 || profile.Tools[0] != "Bash" {
		t.Errorf("tools = %v", profile.Tools)
	}
	if len(profile.Languages) != 1 || profile.Languages[0] != "Python" {
		t.Errorf("languages = %v", profile.Languages)
	}
	// "github" buckets under version-control.
	found := false
	for _, topic := range profile.Topics {
		if topic == "version-control" {
			found = true
		}
	}
	if !found {
		t.Errorf("topics = %v", profile.Topics)
	}
}

func TestBuildProfileEmptySessionsShortCircuits(t *testing.T) {
	s := &Store{CH: &fakeCH{}}
	profile, err := s.BuildProfile(context.Background(), uuid.MustParse(testViewerID), "default")
	if err != nil || !profile.isEmpty() {
		t.Errorf("profile = %+v, err = %v", profile, err)
	}
}

func TestGetOrBuildProfileServesFreshCache(t *testing.T) {
	blob, _ := json.Marshal(WorkProfile{Languages: []string{"Go"}, Topics: []string{"testing"}})
	db := &fakeDB{stubs: []stub{
		{match: "FROM user_work_profiles", rows: &fakeRows{
			cols: []string{"profile", "session_count", "computed_at"},
			rows: [][]any{{blob, 5, time.Now().Add(-time.Hour)}},
		}},
	}}
	s := &Store{DB: db, CH: &fakeCH{}}
	profile, err := s.GetOrBuildProfile(context.Background(), uuid.MustParse(testViewerID), "default", false)
	if err != nil {
		t.Fatalf("cached read: %v", err)
	}
	if profile.SessionCount != 5 || len(profile.Languages) != 1 || profile.Languages[0] != "Go" {
		t.Errorf("cached profile: %+v", profile)
	}
	// A cache hit never touches the analytics store.
	for _, sql := range db.log {
		if strings.Contains(sql, "INSERT INTO user_work_profiles") {
			t.Errorf("cache hit must not persist: %v", db.log)
		}
	}
}

func TestGetOrBuildProfileComputesAndPersistsOnMiss(t *testing.T) {
	db := &fakeDB{}
	ch := &fakeCH{}
	ch.add("FROM session_stats_agg", []map[string]any{{"session_id": "s1", "harness": "pi"}}, nil)
	s := &Store{DB: db, CH: ch}
	profile, err := s.GetOrBuildProfile(context.Background(), uuid.MustParse(testViewerID), "default", false)
	if err != nil {
		t.Fatalf("miss: %v", err)
	}
	if profile.SessionCount != 1 {
		t.Errorf("profile = %+v", profile)
	}
	found := false
	for _, sql := range db.log {
		if strings.Contains(sql, "INSERT INTO user_work_profiles") {
			found = true
		}
	}
	if !found {
		t.Errorf("no insert issued:\n%v", db.log)
	}
}

func TestGetOrBuildProfileRefreshBypassesCache(t *testing.T) {
	blob, _ := json.Marshal(WorkProfile{Languages: []string{"Go"}})
	db := &fakeDB{stubs: []stub{
		{match: "FROM user_work_profiles", rows: &fakeRows{
			cols: []string{"profile", "session_count", "computed_at"},
			rows: [][]any{{blob, 5, time.Now().Add(-time.Hour)}},
		}},
	}}
	s := &Store{DB: db, CH: &fakeCH{}}
	profile, err := s.GetOrBuildProfile(context.Background(), uuid.MustParse(testViewerID), "default", true)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if !profile.isEmpty() {
		t.Errorf("refresh must recompute, got %+v", profile)
	}
	found := false
	for _, sql := range db.log {
		if strings.Contains(sql, "UPDATE user_work_profiles") {
			found = true
		}
	}
	if !found {
		t.Errorf("refresh must update the cached row:\n%v", db.log)
	}
}
