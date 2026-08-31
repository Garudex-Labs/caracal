// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

var (
	testActorID   = "22222222-2222-2222-2222-222222222222"
	testAgentID   = "11111111-1111-1111-1111-111111111111"
	testReportID  = "33333333-3333-3333-3333-333333333333"
	testOwnerID   = "44444444-4444-4444-4444-444444444444"
	testReviewer  = "55555555-5555-5555-5555-555555555555"
	testListingID = "66666666-6666-6666-6666-666666666666"
	testVersionID = "77777777-7777-7777-7777-777777777777"
)

// reportRowStub answers the initial insight_reports read.
func reportRowStub(agentID, status string, appliedAt any, narrative string) stub {
	return stub{match: "SELECT agent_id::text, status::text", rows: &fakeRows{
		rows: [][]any{{agentID, status, appliedAt, []byte(narrative)}},
	}}
}

// agentRowStub answers the agents context read.
func agentRowStub(private bool, projectID any) stub {
	return stub{match: "coalesce(owner, '')", rows: &fakeRows{
		rows: [][]any{{testAgentID, "Review Bot", "acme", "review-bot", "acme-owner", testOwnerID, private, projectID}},
	}}
}

func TestApplyReportRejectsInvalidInputs(t *testing.T) {
	ctx := context.Background()

	t.Run("invalid actor", func(t *testing.T) {
		s := &Store{DB: &fakeDB{}}
		if _, err := s.ApplyReport(ctx, testReportID, "", "not-a-uuid", nil); err == nil ||
			!strings.Contains(err.Error(), "invalid actor user id") {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("malformed report id", func(t *testing.T) {
		s := &Store{DB: &fakeDB{}}
		_, err := s.ApplyReport(ctx, "nope", "", testActorID, nil)
		var applyErr *ApplyError
		if !errors.As(err, &applyErr) || applyErr.Status != 404 {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("begin failure", func(t *testing.T) {
		s := &Store{DB: &fakeDB{beginErr: errors.New("pool exhausted")}}
		if _, err := s.ApplyReport(ctx, testReportID, "", testActorID, nil); err == nil ||
			!strings.Contains(err.Error(), "pool exhausted") {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("report not found", func(t *testing.T) {
		s := &Store{DB: &fakeDB{}}
		_, err := s.ApplyReport(ctx, testReportID, "", testActorID, nil)
		var applyErr *ApplyError
		if !errors.As(err, &applyErr) || applyErr.Status != 404 || applyErr.Detail != "Report not found" {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("agent mismatch", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{reportRowStub(testAgentID, "completed", nil, "{}")}}
		s := &Store{DB: db}
		_, err := s.ApplyReport(ctx, testReportID, testOwnerID, testActorID, nil)
		var applyErr *ApplyError
		if !errors.As(err, &applyErr) || applyErr.Detail != "Report not found for agent" {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("not completed", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{reportRowStub(testAgentID, "running", nil, "{}")}}
		s := &Store{DB: db}
		_, err := s.ApplyReport(ctx, testReportID, "", testActorID, nil)
		var applyErr *ApplyError
		if !errors.As(err, &applyErr) || applyErr.Status != 400 || applyErr.Detail != "Report is not completed" {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("already applied", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{
			reportRowStub(testAgentID, "completed", time.Now(), "{}"),
			agentRowStub(false, nil),
		}}
		s := &Store{DB: db}
		_, err := s.ApplyReport(ctx, testReportID, "", testActorID, nil)
		var applyErr *ApplyError
		if !errors.As(err, &applyErr) || !strings.Contains(applyErr.Detail, "already been applied") {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("agent gone", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{reportRowStub(testAgentID, "completed", nil, "{}")}}
		s := &Store{DB: db}
		_, err := s.ApplyReport(ctx, testReportID, "", testActorID, nil)
		var applyErr *ApplyError
		if !errors.As(err, &applyErr) || applyErr.Detail != "Agent not found" {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("no suggestions", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{
			reportRowStub(testAgentID, "completed", nil, `{"suggestions": {}}`),
			agentRowStub(false, nil),
			{match: "SELECT 1 FROM users WHERE id", rows: &fakeRows{rows: [][]any{{1}}}},
		}}
		s := &Store{DB: db}
		_, err := s.ApplyReport(ctx, testReportID, "", testActorID, nil)
		var applyErr *ApplyError
		if !errors.As(err, &applyErr) || !strings.Contains(applyErr.Detail, "no suggestions") {
			t.Errorf("err = %v", err)
		}
	})
}

func TestApplyReportCreatesSkillPromptAndVersion(t *testing.T) {
	narrative := `{
		"suggestions": {
			"features_to_try": [
				{"feature": "Create a custom skill", "name": "lint-fix",
				 "one_liner": "Lints and fixes Go code", "example": "run golangci-lint",
				 "confidence": "high", "risk": "low", "why_for_you": "you lint a lot"},
				{"feature": "Create a custom skill", "name": "no-example"}
			],
			"usage_patterns": [
				{"title": "Great prompt", "copyable_prompt": "Do X carefully", "detail": "Detail text"},
				{"title": "no prompt to copy"}
			],
			"config_additions": [
				{"addition": "Always run tests", "where": "system_prompt", "why": "safety", "confidence": "high"}
			]
		}
	}`
	skillVersionID := uuid.NewString()
	promptListingID := uuid.NewString()
	promptVersionID := uuid.NewString()
	newVersionID := uuid.NewString()
	mcpCompID := uuid.NewString()
	db := &fakeDB{stubs: []stub{
		reportRowStub(testAgentID, "completed", nil, narrative),
		agentRowStub(false, nil),
		{match: "SELECT 1 FROM users WHERE id", rows: &fakeRows{rows: [][]any{{1}}}},
		{match: "AND status = 'pending'", rows: &fakeRows{rows: [][]any{
			{uuid.NewString(), "1.2.3", "Self-learned from insights: old proposal"},
			{uuid.NewString(), "1.1.0", "Manual release"},
		}}},
		// findExistingSkillMatch: nothing matches.
		{match: "v.version, v.description", rows: &fakeRows{}},
		{match: "SELECT 1 FROM skill_listings", rows: &fakeRows{}},
		{match: "INSERT INTO skill_listings", rows: &fakeRows{rows: [][]any{{testListingID}}}},
		{match: "INSERT INTO skill_versions", rows: &fakeRows{rows: [][]any{{skillVersionID}}}},
		{match: "SELECT 1 FROM prompt_listings", rows: &fakeRows{}},
		{match: "INSERT INTO prompt_listings", rows: &fakeRows{rows: [][]any{{promptListingID}}}},
		{match: "INSERT INTO prompt_versions", rows: &fakeRows{rows: [][]any{{promptVersionID}}}},
		{match: "INSERT INTO agent_versions", rows: &fakeRows{rows: [][]any{{newVersionID}}}},
		{match: "SELECT id::text, version, prompt, model_name", rows: &fakeRows{rows: [][]any{
			{testVersionID, "1.2.3", "Base prompt", "gpt-5",
				[]byte("{}"), []byte("{}"), []byte("[]"), []byte(`["kiro"]`)},
		}}},
		{match: "AND version = $2 LIMIT 1", rows: &fakeRows{}},
		{match: "config_override", rows: &fakeRows{rows: [][]any{
			{"mcp", mcpCompID, "github", "2.0.0", 0, nil},
		}}},
		{match: "name FROM skill_listings", rows: &fakeRows{rows: [][]any{
			{testListingID, "review-bot-lint-fix"},
		}}},
		{match: "name FROM prompt_listings", rows: &fakeRows{rows: [][]any{
			{promptListingID, "review-bot-great-prompt"},
		}}},
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{rows: [][]any{
			{"mcp", mcpCompID},
			{"skill", testListingID},
			{"prompt", promptListingID},
		}}},
		{match: "slash_command", rows: &fakeRows{rows: [][]any{{""}}}},
		{match: "role IN ('reviewer', 'operator')", rows: &fakeRows{rows: [][]any{
			{uuid.MustParse(testReviewer)},
		}}},
	}}
	s := &Store{DB: db}

	out, err := s.ApplyReport(context.Background(), testReportID, testAgentID, testActorID, nil)
	if err != nil {
		t.Fatalf("ApplyReport: %v", err)
	}
	if out["applied"] != true || out["report_id"] != testReportID {
		t.Errorf("envelope: %v", out)
	}
	items := out["items"].(map[string]any)

	skills := items["skills"].([]any)
	if len(skills) != 1 {
		t.Fatalf("skills = %v", skills)
	}
	skill := skills[0].(map[string]any)
	if skill["name"] != "review-bot-lint-fix" || skill["id"] != testListingID || skill["type"] != "skill" {
		t.Errorf("skill entry: %v", skill)
	}
	if skill["confidence"] != "high" || skill["risk"] != "low" {
		t.Errorf("skill risk fields: %v", skill)
	}

	prompts := items["prompts"].([]any)
	if len(prompts) != 1 {
		t.Fatalf("prompts = %v", prompts)
	}
	if prompts[0].(map[string]any)["name"] != "review-bot-great-prompt" {
		t.Errorf("prompt entry: %v", prompts[0])
	}

	additions := items["prompt_additions"].([]any)
	if len(additions) != 1 || additions[0].(map[string]any)["risk"] != "low" {
		t.Errorf("prompt_additions: %v", additions)
	}

	superseded := items["superseded_agent_versions"].([]any)
	if len(superseded) != 1 {
		t.Errorf("only the self-learned pending version withdraws: %v", superseded)
	}
	if got := db.sqlCalls("SET status = 'rejected'"); len(got) != 1 {
		t.Errorf("withdraw update ran %d times", len(got))
	}

	version := items["agent_version"].(map[string]any)
	if version["version"] != "1.2.4" || version["id"] != newVersionID {
		t.Errorf("agent version: %v", version)
	}
	if version["additions_count"] != 1 || version["linked_components"] != 2 || version["removed_components"] != 0 {
		t.Errorf("version counters: %v", version)
	}

	// The new prompt carries the separator plus the addition.
	inserts := db.sqlCalls("INSERT INTO agent_versions")
	if len(inserts) != 1 {
		t.Fatalf("agent version inserts: %d", len(inserts))
	}
	newPrompt := inserts[0].args[3].(string)
	if !strings.Contains(newPrompt, "Base prompt") || !strings.Contains(newPrompt, "Always run tests") ||
		!strings.Contains(newPrompt, "Auto-learned from Insights") {
		t.Errorf("new prompt:\n%s", newPrompt)
	}

	// Carried mcp + created skill + created prompt land as components.
	compInserts := db.sqlCalls("INSERT INTO agent_components")
	if len(compInserts) != 3 {
		t.Errorf("component inserts = %d", len(compInserts))
	}

	// Capability inference: only the carried mcp demands a capability.
	capUpdates := db.sqlCalls("SET required_capabilities")
	if len(capUpdates) != 1 {
		t.Fatalf("capability updates = %d", len(capUpdates))
	}
	if req := capUpdates[0].args[1].(string); req != `["mcp_servers"]` {
		t.Errorf("required_capabilities = %s", req)
	}

	// One inbox item per pending artifact: skill, prompt, agent version.
	if got := db.sqlCalls("INSERT INTO inbox_items"); len(got) != 3 {
		t.Errorf("inbox deliveries = %d", len(got))
	}
	if got := db.sqlCalls("UPDATE insight_reports SET applied_at"); len(got) != 1 {
		t.Errorf("applied_at updates = %d", len(got))
	}
	if db.commits == 0 {
		t.Error("transaction never committed")
	}
}

func TestApplyReportReuseRemoveAndHook(t *testing.T) {
	reuseID := uuid.NewString()
	removedID := uuid.NewString()
	hookListingID := uuid.NewString()
	mcpCompID := uuid.NewString()
	projectID := uuid.New()
	narrative := `{
		"suggestions": {
			"features_to_try": [
				{"action_type": "attach_registry_component", "existing_component_id": "` + reuseID + `",
				 "feature": "reuse this skill", "why_for_you": "already exists",
				 "confidence": "high", "risk": "low"},
				{"action_type": "remove_component", "existing_component_id": "` + removedID + `",
				 "name": "old-hook", "why_for_you": "unused"},
				{"action_type": "remove_component", "existing_component_id": "not-a-uuid", "name": "bad"},
				{"feature": "install an MCP server", "example": "docker run x"},
				{"feature": "add a pre-commit hook", "name": "guard",
				 "one_liner": "Runs git diff", "example": "# hook: run before commit\ngit diff --stat"},
				{"feature": "add a hook without example"}
			]
		}
	}`
	db := &fakeDB{stubs: []stub{
		reportRowStub(testAgentID, "completed", nil, narrative),
		agentRowStub(true, projectID),
		{match: "SELECT 1 FROM users WHERE id", rows: &fakeRows{rows: [][]any{{1}}}},
		{match: "AND status = 'pending'", rows: &fakeRows{}},
		{match: "WHERE l.id = $1", rows: &fakeRows{rows: [][]any{
			{reuseID, "Existing Skill", "acme", "existing-skill", "2.1.0"},
		}}},
		{match: "SELECT 1 FROM hook_listings", rows: &fakeRows{}},
		{match: "INSERT INTO hook_listings", rows: &fakeRows{rows: [][]any{{hookListingID}}}},
		{match: "INSERT INTO hook_versions", rows: &fakeRows{rows: [][]any{{uuid.NewString()}}}},
		{match: "INSERT INTO agent_versions", rows: &fakeRows{rows: [][]any{{uuid.NewString()}}}},
		{match: "SELECT id::text, version, prompt, model_name", rows: &fakeRows{rows: [][]any{
			{testVersionID, "0.1.0", "Base prompt", "gpt-5",
				[]byte("{}"), []byte("{}"), []byte("[]"), []byte(`["kiro"]`)},
		}}},
		{match: "AND version = $2 LIMIT 1", rows: &fakeRows{}},
		{match: "config_override", rows: &fakeRows{rows: [][]any{
			{"mcp", mcpCompID, "github", "2.0.0", 0, []byte(`{"k":1}`)},
			{"hook", removedID, "old-hook", "1.0.0", 3, nil},
		}}},
		{match: "name FROM hook_listings", rows: &fakeRows{rows: [][]any{
			{hookListingID, "review-bot-guard"},
		}}},
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{rows: [][]any{
			{"mcp", mcpCompID},
			{"hook", hookListingID},
			{"skill", reuseID},
		}}},
		{match: "slash_command", rows: &fakeRows{rows: [][]any{{"/existing"}}}},
		{match: "role IN ('reviewer', 'operator')", rows: &fakeRows{rows: [][]any{
			{uuid.MustParse(testReviewer)},
		}}},
		{match: "FROM project_memberships WHERE project_id", rows: &fakeRows{rows: [][]any{
			{uuid.MustParse(testReviewer)},
		}}},
	}}
	s := &Store{DB: db}

	out, err := s.ApplyReport(context.Background(), testReportID, "", testActorID, nil)
	if err != nil {
		t.Fatalf("ApplyReport: %v", err)
	}
	items := out["items"].(map[string]any)

	linked := items["linked_existing"].([]any)
	if len(linked) != 1 {
		t.Fatalf("linked_existing = %v", linked)
	}
	entry := linked[0].(map[string]any)
	if entry["qualified_name"] != "acme/existing-skill" || entry["type"] != "skill" || entry["version"] != "2.1.0" {
		t.Errorf("linked entry: %v", entry)
	}

	removed := items["removed_components"].([]any)
	if len(removed) != 1 || removed[0].(map[string]any)["id"] != removedID {
		t.Errorf("removed_components: %v", removed)
	}

	hooks := items["hooks"].([]any)
	if len(hooks) != 1 || hooks[0].(map[string]any)["name"] != "review-bot-guard" {
		t.Errorf("hooks: %v", hooks)
	}

	// The hook version insert carries the parsed event and mode plus the
	// bash-wrapped script.
	hookInserts := db.sqlCalls("INSERT INTO hook_versions")
	if len(hookInserts) != 1 {
		t.Fatalf("hook version inserts = %d", len(hookInserts))
	}
	args := hookInserts[0].args
	if args[3] != "Stop" || args[4] != "blocking" {
		t.Errorf("hook event/mode = %v/%v", args[3], args[4])
	}
	if script := args[5].(string); !strings.HasPrefix(script, "#!/usr/bin/env bash") ||
		!strings.Contains(script, "git diff --stat") {
		t.Errorf("hook script:\n%s", script)
	}

	// MCP suggestions are never materialized.
	if got := db.sqlCalls("INSERT INTO mcp_listings"); len(got) != 0 {
		t.Errorf("mcp creation must be refused: %v", got)
	}

	version := items["agent_version"].(map[string]any)
	if version["version"] != "0.1.1" || version["linked_components"] != 2 || version["removed_components"] != 1 {
		t.Errorf("version: %v", version)
	}

	// Components: carried mcp (removed hook skipped), new hook, linked skill.
	compInserts := db.sqlCalls("INSERT INTO agent_components")
	if len(compInserts) != 3 {
		t.Errorf("component inserts = %d", len(compInserts))
	}
	for _, c := range compInserts {
		if c.args[3] == removedID {
			t.Errorf("removed component must not carry over: %v", c.args)
		}
	}

	// The slash-commanded skill plus hook plus mcp demand all three
	// capabilities.
	capUpdates := db.sqlCalls("SET required_capabilities")
	if len(capUpdates) != 1 {
		t.Fatalf("capability updates = %d", len(capUpdates))
	}
	if req := capUpdates[0].args[1].(string); req != `["hooks","mcp_servers","skills"]` {
		t.Errorf("required_capabilities = %s", req)
	}
}

func TestApplyReportReuseRejectedWhenUnresolvable(t *testing.T) {
	reuseID := uuid.NewString()
	narrative := `{
		"suggestions": {
			"features_to_try": [
				{"action_type": "reuse_existing_component", "existing_component_id": "` + reuseID + `",
				 "feature": "reuse a skill"}
			]
		}
	}`
	db := &fakeDB{stubs: []stub{
		reportRowStub(testAgentID, "completed", nil, narrative),
		agentRowStub(false, nil),
		{match: "AND status = 'pending'", rows: &fakeRows{}},
	}}
	s := &Store{DB: db}

	out, err := s.ApplyReport(context.Background(), testReportID, "", testActorID, nil)
	if err != nil {
		t.Fatalf("ApplyReport: %v", err)
	}
	items := out["items"].(map[string]any)
	if linked := items["linked_existing"].([]any); len(linked) != 0 {
		t.Errorf("unresolvable reuse must be dropped: %v", linked)
	}
	if items["agent_version"] != nil {
		t.Errorf("nothing applied must not create a version: %v", items["agent_version"])
	}
	// Every component family was probed for the id.
	if probes := db.sqlCalls("WHERE l.id = $1"); len(probes) != 4 {
		t.Errorf("family probes = %d, want 4", len(probes))
	}
}

func TestApplyReportSelectionFiltersIndices(t *testing.T) {
	narrative := `{
		"suggestions": {
			"features_to_try": [
				{"feature": "Create a custom skill", "name": "keep-me",
				 "one_liner": "kept", "example": "example"}
			],
			"config_additions": [
				{"addition": "Dropped addition", "where": "system_prompt"}
			]
		}
	}`
	db := &fakeDB{stubs: []stub{
		reportRowStub(testAgentID, "completed", nil, narrative),
		agentRowStub(false, nil),
		{match: "AND status = 'pending'", rows: &fakeRows{}},
	}}
	s := &Store{DB: db}

	// Explicit empty selections apply nothing at all.
	selection := &ApplySelection{ConfigIndices: []int{}, FeatureIndices: []int{}, PatternIndices: []int{}}
	out, err := s.ApplyReport(context.Background(), testReportID, "", testActorID, selection)
	if err != nil {
		t.Fatalf("ApplyReport: %v", err)
	}
	items := out["items"].(map[string]any)
	if len(items["skills"].([]any)) != 0 || items["agent_version"] != nil {
		t.Errorf("empty selection must apply nothing: %v", items)
	}
	if _, present := items["prompt_additions"]; present {
		t.Errorf("prompt_additions must be absent: %v", items)
	}
}

func TestWithdrawStaleInsightVersions(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "AND status = 'pending'", rows: &fakeRows{rows: [][]any{
			{"id-1", "1.0.1", "Self-learned from insights: 2 prompt additions"},
			{"id-2", "1.0.2", "Hand-written version"},
		}}},
	}}
	tx := &fakeTx{db: db}
	withdrawn, err := withdrawStaleInsightVersions(context.Background(), tx, testAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if len(withdrawn) != 1 {
		t.Fatalf("withdrawn = %v", withdrawn)
	}
	entry := withdrawn[0].(map[string]any)
	if entry["id"] != "id-1" || entry["version"] != "1.0.1" {
		t.Errorf("entry = %v", entry)
	}
	updates := db.sqlCalls("SET status = 'rejected'")
	if len(updates) != 1 {
		t.Fatalf("updates = %d", len(updates))
	}
	ids := updates[0].args[0].([]string)
	if len(ids) != 1 || ids[0] != "id-1" {
		t.Errorf("withdrawn ids = %v", ids)
	}
}

func TestWithdrawStaleNothingPending(t *testing.T) {
	db := &fakeDB{}
	withdrawn, err := withdrawStaleInsightVersions(context.Background(), &fakeTx{db: db}, testAgentID)
	if err != nil || len(withdrawn) != 0 {
		t.Errorf("withdrawn = %v, err = %v", withdrawn, err)
	}
	if got := db.sqlCalls("SET status = 'rejected'"); len(got) != 0 {
		t.Errorf("no update expected: %v", got)
	}
}

func TestDeliverReviewRequestedBranches(t *testing.T) {
	actor := uuid.MustParse(testActorID)
	reviewer := uuid.MustParse(testReviewer)
	subjectID := uuid.New()
	subject := listingSubject("skill", subjectID.String(), "n", &applyAgent{namespace: "acme"}, "n", "1.0.0")

	t.Run("private without project notifies operators", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{
			{match: "WHERE role = 'operator'", rows: &fakeRows{rows: [][]any{{reviewer}}}},
		}}
		if err := deliverReviewRequested(context.Background(), &fakeTx{db: db}, subject, nil, true, actor); err != nil {
			t.Fatal(err)
		}
		if got := db.sqlCalls("INSERT INTO inbox_items"); len(got) != 1 {
			t.Errorf("deliveries = %d", len(got))
		}
	})

	t.Run("private with project notifies its leads", func(t *testing.T) {
		projectID := uuid.New()
		db := &fakeDB{stubs: []stub{
			{match: "FROM project_memberships WHERE project_id", rows: &fakeRows{rows: [][]any{{reviewer}}}},
		}}
		if err := deliverReviewRequested(context.Background(), &fakeTx{db: db}, subject, &projectID, true, actor); err != nil {
			t.Fatal(err)
		}
		if got := db.sqlCalls("INSERT INTO inbox_items"); len(got) != 1 {
			t.Errorf("deliveries = %d", len(got))
		}
	})

	t.Run("public with project merges and dedupes recipients", func(t *testing.T) {
		projectID := uuid.New()
		db := &fakeDB{stubs: []stub{
			{match: "role IN ('reviewer', 'operator')", rows: &fakeRows{rows: [][]any{{reviewer}, {actor}}}},
			{match: "FROM project_memberships WHERE project_id", rows: &fakeRows{rows: [][]any{{reviewer}}}},
		}}
		if err := deliverReviewRequested(context.Background(), &fakeTx{db: db}, subject, &projectID, false, actor); err != nil {
			t.Fatal(err)
		}
		// The reviewer got one item; the duplicate and the actor were
		// absorbed.
		if got := db.sqlCalls("INSERT INTO inbox_items"); len(got) != 1 {
			t.Errorf("deliveries = %d", len(got))
		}
	})

	t.Run("recipient query failure surfaces", func(t *testing.T) {
		db := &fakeDB{queryErr: map[string]error{"FROM users": errors.New("db down")}}
		if err := deliverReviewRequested(context.Background(), &fakeTx{db: db}, subject, nil, false, actor); err == nil {
			t.Error("collect failure must surface")
		}
	})
}

func TestCreateAgentVersionExhaustsNumbering(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT id::text, version, prompt, model_name", rows: &fakeRows{rows: [][]any{
			{testVersionID, "1.0.0", "Base prompt", "gpt-5",
				[]byte("{}"), []byte("{}"), []byte("[]"), []byte(`["kiro"]`)},
		}}},
		// Every candidate number is taken.
		{match: "AND version = $2 LIMIT 1", rows: &fakeRows{rows: [][]any{{1}}}},
	}}
	agent := &applyAgent{id: testAgentID, name: "Review Bot", namespace: "acme", slug: "review-bot"}
	info, err := createAgentVersionWithAdditions(context.Background(), &fakeTx{db: db}, agent,
		[]map[string]any{{"addition": "New rule", "where": "system_prompt"}},
		uuid.MustParse(testOwnerID), nil, nil, nil, uuid.MustParse(testActorID))
	if err != nil || info != nil {
		t.Errorf("exhausted numbering must give up quietly: %v, %v", info, err)
	}
	if got := db.sqlCalls("INSERT INTO agent_versions"); len(got) != 0 {
		t.Errorf("no version insert expected: %d", len(got))
	}
}

func TestCreateAgentVersionNoApprovedBase(t *testing.T) {
	db := &fakeDB{}
	agent := &applyAgent{id: testAgentID, name: "Review Bot"}
	info, err := createAgentVersionWithAdditions(context.Background(), &fakeTx{db: db}, agent,
		[]map[string]any{{"addition": "x", "where": "system_prompt"}},
		uuid.MustParse(testOwnerID), nil, nil, nil, uuid.MustParse(testActorID))
	if err != nil || info != nil {
		t.Errorf("missing approved version must give up quietly: %v, %v", info, err)
	}
}

func TestCreateAgentVersionDropsDuplicateAdditions(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT id::text, version, prompt, model_name", rows: &fakeRows{rows: [][]any{
			{testVersionID, "1.0.0", "Base prompt already says ALWAYS RUN TESTS.", "gpt-5",
				[]byte("{}"), []byte("{}"), []byte("[]"), []byte(`["kiro"]`)},
		}}},
	}}
	agent := &applyAgent{id: testAgentID, name: "Review Bot"}
	info, err := createAgentVersionWithAdditions(context.Background(), &fakeTx{db: db}, agent,
		[]map[string]any{{"addition": "always run tests", "where": "system_prompt"}},
		uuid.MustParse(testOwnerID), nil, nil, nil, uuid.MustParse(testActorID))
	if err != nil || info != nil {
		t.Errorf("verbatim-duplicate addition must be a no-op: %v, %v", info, err)
	}
}

func TestComponentDisplayNames(t *testing.T) {
	skillID := uuid.NewString()
	hookID := uuid.NewString()
	db := &fakeDB{stubs: []stub{
		{match: "name FROM skill_listings", rows: &fakeRows{rows: [][]any{{skillID, "skill-name"}}}},
		{match: "name FROM hook_listings", rows: &fakeRows{rows: [][]any{{hookID, "hook-name"}}}},
	}}
	names, err := componentDisplayNames(context.Background(), &fakeTx{db: db}, []createdComponent{
		{ctype: "skill", id: skillID},
		{ctype: "hook", id: hookID},
		{ctype: "unknown-type", id: uuid.NewString()},
	})
	if err != nil {
		t.Fatal(err)
	}
	if names[skillID] != "skill-name" || names[hookID] != "hook-name" || len(names) != 2 {
		t.Errorf("names = %v", names)
	}
}

func TestRefreshCapabilityInferenceExternalMcps(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{}},
	}}
	err := refreshCapabilityInference(context.Background(), &fakeTx{db: db},
		uuid.NewString(), []byte(`[{"name": "external"}]`))
	if err != nil {
		t.Fatal(err)
	}
	updates := db.sqlCalls("SET required_capabilities")
	if len(updates) != 1 {
		t.Fatalf("updates = %d", len(updates))
	}
	if req := updates[0].args[1].(string); req != `["mcp_servers"]` {
		t.Errorf("required = %s", req)
	}
	// Every harness that supports mcp_servers appears in the inferred set.
	supported := updates[0].args[2].(string)
	var names []string
	if err := json.Unmarshal([]byte(supported), &names); err != nil || len(names) == 0 {
		t.Errorf("inferred harnesses = %s (%v)", supported, err)
	}
}
