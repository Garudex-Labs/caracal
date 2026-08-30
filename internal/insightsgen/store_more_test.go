// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestReapStale(t *testing.T) {
	db := &fakeDB{execTags: map[string]pgconn.CommandTag{
		"UPDATE insight_reports": pgconn.NewCommandTag("UPDATE 3"),
	}}
	s := &Store{DB: db}
	n, err := s.ReapStale(context.Background())
	if err != nil || n != 3 {
		t.Errorf("ReapStale = %d, %v", n, err)
	}

	db = &fakeDB{execErr: map[string]error{"UPDATE insight_reports": errors.New("down")}}
	if _, err := (&Store{DB: db}).ReapStale(context.Background()); err == nil {
		t.Error("exec failure must surface")
	}
}

func TestClaimPending(t *testing.T) {
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC)
	db := &fakeDB{stubs: []stub{
		{match: "FOR UPDATE SKIP LOCKED", rows: &fakeRows{rows: [][]any{
			{testReportID, testAgentID, "1.2.0", "1.1.0", start, end, "prev-id", "user-1"},
		}}},
	}}
	j, err := (&Store{DB: db}).ClaimPending(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if j.ReportID != testReportID || j.AgentID != testAgentID || j.AgentVersion != "1.2.0" ||
		j.ComparisonAgentVersion != "1.1.0" || j.PreviousReportID != "prev-id" || j.TriggeredBy != "user-1" {
		t.Errorf("job = %+v", j)
	}
	if !j.PeriodStart.Equal(start) || !j.PeriodEnd.Equal(end) {
		t.Errorf("period = %v to %v", j.PeriodStart, j.PeriodEnd)
	}

	// Nothing pending is a nil job, not an error.
	j, err = (&Store{DB: &fakeDB{}}).ClaimPending(context.Background())
	if err != nil || j != nil {
		t.Errorf("empty queue = %+v, %v", j, err)
	}
}

func TestUpdateProgressComputesPercent(t *testing.T) {
	db := &fakeDB{}
	s := &Store{DB: db}
	s.UpdateProgress(context.Background(), testReportID, "extracting", 3, 9, "working")
	calls := db.sqlCalls("progress_phase = $2")
	if len(calls) != 1 {
		t.Fatalf("updates = %d", len(calls))
	}
	if calls[0].args[4] != 3*100/9 {
		t.Errorf("percent = %v", calls[0].args[4])
	}

	// Zero total never divides by zero.
	s.UpdateProgress(context.Background(), testReportID, "queued", 0, 0, "")
	calls = db.sqlCalls("progress_phase = $2")
	if calls[1].args[4] != 0 {
		t.Errorf("zero-total percent = %v", calls[1].args[4])
	}

	// A failing write only logs.
	bad := &Store{DB: &fakeDB{execErr: map[string]error{"progress_phase": errors.New("down")}}}
	bad.UpdateProgress(context.Background(), testReportID, "x", 1, 2, "")
}

func TestAgentNameAndCreator(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT name FROM agents", rows: &fakeRows{rows: [][]any{{"Review Bot"}}}},
		{match: "SELECT created_by::text FROM agents", rows: &fakeRows{rows: [][]any{{testOwnerID}}}},
	}}
	s := &Store{DB: db}
	if got := s.AgentName(context.Background(), testAgentID); got != "Review Bot" {
		t.Errorf("AgentName = %q", got)
	}
	if got := s.AgentCreator(context.Background(), testAgentID); got != testOwnerID {
		t.Errorf("AgentCreator = %q", got)
	}

	missing := &Store{DB: &fakeDB{}}
	if got := missing.AgentName(context.Background(), testAgentID); got != "Unknown Agent" {
		t.Errorf("missing agent name = %q", got)
	}
	if got := missing.AgentCreator(context.Background(), testAgentID); got != "" {
		t.Errorf("missing agent creator = %q", got)
	}
}

func TestAgentScope(t *testing.T) {
	scope := agentScope(testOwnerID, map[string]any{
		"current_components": []any{
			map[string]any{"id": testListingID},
			map[string]any{"id": "not-a-uuid"},
			"not-a-map",
		},
	})
	if !scope.HasUser || scope.UserID.String() != testOwnerID {
		t.Errorf("scope user = %+v", scope)
	}
	if len(scope.AttachedIDs) != 1 || scope.AttachedIDs[0].String() != testListingID {
		t.Errorf("attached = %v", scope.AttachedIDs)
	}

	empty := agentScope("bogus", nil)
	if empty.HasUser || len(empty.AttachedIDs) != 0 {
		t.Errorf("empty scope = %+v", empty)
	}
}

func TestLoadAgentConfig(t *testing.T) {
	mcpID, skillID, hookID, promptID := "m", "s", "h", "p"
	db := &fakeDB{stubs: []stub{
		{match: "FROM agent_versions v", rows: &fakeRows{rows: [][]any{
			{testVersionID, "1.4.0", "gpt-5", []byte(`["kiro", "pi"]`),
				"You are a careful reviewer.", []byte(`{"temperature": 0.2}`),
				[]byte(`[{"name": "external-mcp"}, {"server_name": "github"}, {"other": true}]`)},
		}}},
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{rows: [][]any{
			{"mcp", "12345678-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "github", "1.0.0"},
			{"skill", "12345678-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "", ""},
			{"hook", "12345678-cccc-cccc-cccc-cccccccccccc", "guard", "2.0.0"},
			{"prompt", "12345678-dddd-dddd-dddd-dddddddddddd", "starter", ""},
		}}},
	}}
	_ = []string{mcpID, skillID, hookID, promptID}
	config, err := (&Store{DB: db}).LoadAgentConfig(context.Background(), testAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if config["version"] != "1.4.0" || config["model"] != "gpt-5" {
		t.Errorf("identity: %v", config)
	}
	if config["system_prompt_length"] != len("You are a careful reviewer.") {
		t.Errorf("prompt length: %v", config["system_prompt_length"])
	}
	// The external mcp named github duplicates the attached one and is
	// absorbed.
	mcps := config["configured_mcps"].([]string)
	if len(mcps) != 2 || mcps[0] != "github" || mcps[1] != "external-mcp" {
		t.Errorf("configured_mcps = %v", mcps)
	}
	// A nameless component renders as a truncated id stub.
	skills := config["configured_skills"].([]string)
	if len(skills) != 1 || skills[0] != "12345678" {
		t.Errorf("configured_skills = %v", skills)
	}
	if len(config["configured_hooks"].([]string)) != 1 || len(config["configured_prompts"].([]string)) != 1 {
		t.Errorf("hook/prompt names: %v", config)
	}
	components := config["current_components"].([]any)
	if len(components) != 4 {
		t.Errorf("current_components = %v", components)
	}
	first := components[0].(map[string]any)
	if first["resolved_version"] != "1.0.0" {
		t.Errorf("resolved_version: %v", first)
	}
	second := components[1].(map[string]any)
	if second["resolved_version"] != nil {
		t.Errorf("empty resolved_version must be null: %v", second)
	}
	mc := config["model_config"].(map[string]any)
	if mc["temperature"] != 0.2 {
		t.Errorf("model_config = %v", mc)
	}
}

func TestLoadAgentConfigNoApprovedVersion(t *testing.T) {
	config, err := (&Store{DB: &fakeDB{}}).LoadAgentConfig(context.Background(), testAgentID)
	if err != nil || config != nil {
		t.Errorf("config = %v, err = %v", config, err)
	}
}

func TestPreviousMetrics(t *testing.T) {
	s := &Store{DB: &fakeDB{stubs: []stub{
		{match: "SELECT aggregated_data", rows: &fakeRows{rows: [][]any{{[]byte(`{"metrics": {"a": 1}}`)}}}},
	}}}
	if got := s.PreviousMetrics(context.Background(), ""); got != nil {
		t.Errorf("empty id = %v", got)
	}
	got := s.PreviousMetrics(context.Background(), "prev-id")
	if got == nil || got["metrics"] == nil {
		t.Errorf("metrics = %v", got)
	}

	bad := &Store{DB: &fakeDB{stubs: []stub{
		{match: "SELECT aggregated_data", rows: &fakeRows{rows: [][]any{{[]byte("{broken")}}}},
	}}}
	if got := bad.PreviousMetrics(context.Background(), "prev-id"); got != nil {
		t.Errorf("bad json = %v", got)
	}
}

func TestCompletePersistsAndDeliversToRequester(t *testing.T) {
	db := &fakeDB{}
	s := &Store{DB: db}
	j := &job{ReportID: testReportID, AgentID: testAgentID, TriggeredBy: testOwnerID}
	content := &reportContent{
		Metrics:          map[string]any{"rich": map[string]any{}},
		Narrative:        map[string]any{"at_a_glance": map[string]any{}},
		SessionsAnalyzed: 4,
		ModelsUsed:       []string{"m1", "m2"},
	}
	if err := s.Complete(context.Background(), j, "Review Bot", content); err != nil {
		t.Fatal(err)
	}
	updates := db.sqlCalls("status = 'completed'")
	if len(updates) != 1 {
		t.Fatalf("completion updates = %d", len(updates))
	}
	if model := *(updates[0].args[5].(*string)); model != "m1, m2" {
		t.Errorf("llm_model_used = %q", model)
	}
	inserts := db.sqlCalls("INSERT INTO inbox_items")
	if len(inserts) != 1 {
		t.Fatalf("inbox inserts = %d", len(inserts))
	}
	if title := inserts[0].args[2].(string); !strings.Contains(title, "Review Bot") {
		t.Errorf("title = %q", title)
	}
	if events := db.sqlCalls("INSERT INTO inbox_item_events"); len(events) != 1 {
		t.Errorf("event inserts = %d", len(events))
	}
	if db.commits != 1 {
		t.Errorf("commits = %d", db.commits)
	}
}

func TestCompleteScheduledReportSkipsInbox(t *testing.T) {
	db := &fakeDB{}
	s := &Store{DB: db}
	j := &job{ReportID: testReportID, AgentID: testAgentID, TriggeredBy: ""}
	content := &reportContent{Metrics: map[string]any{}, Narrative: map[string]any{}}
	if err := s.Complete(context.Background(), j, "Review Bot", content); err != nil {
		t.Fatal(err)
	}
	if got := db.sqlCalls("INSERT INTO inbox_items"); len(got) != 0 {
		t.Errorf("scheduled reports must not fill inboxes: %d", len(got))
	}
}

func TestDeliverInsightReadyAbsorbsDuplicate(t *testing.T) {
	db := &fakeDB{execTags: map[string]pgconn.CommandTag{
		"INSERT INTO inbox_items": pgconn.NewCommandTag("INSERT 0 0"),
	}}
	err := deliverInsightReady(context.Background(), &fakeTx{db: db}, testReportID, testOwnerID, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := db.sqlCalls("INSERT INTO inbox_item_events"); len(got) != 0 {
		t.Errorf("absorbed duplicate must not record an event: %d", len(got))
	}
	// The empty agent name falls back to a generic label.
	inserts := db.sqlCalls("INSERT INTO inbox_items")
	if title := inserts[0].args[2].(string); !strings.Contains(title, "insight report") {
		t.Errorf("title = %q", title)
	}
}

func TestFail(t *testing.T) {
	db := &fakeDB{}
	if err := (&Store{DB: db}).Fail(context.Background(), testReportID, "boom"); err != nil {
		t.Fatal(err)
	}
	calls := db.sqlCalls("status = 'failed'")
	if len(calls) != 1 || calls[0].args[1] != "boom" {
		t.Errorf("fail update: %v", calls)
	}
}
