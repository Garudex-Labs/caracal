// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

func TestAnalyzeModelEfficiencyFlagsBranchesAndSorts(t *testing.T) {
	metas := []*sessionMeta{
		modelMeta("simple-high", "gpt-5-pro", 1.00, 5, 2, 120, 1),
		modelMeta("complex-low", "gpt-5-mini", 0.50, 6, 12, 900, 8),
		modelMeta("failed-high", "o3", 0.30, 4, 6, 500, 1),
		modelMeta("quota", "claude-opus", 0.20, 5, 2, 100, 1),
	}
	facets := map[string]map[string]any{
		"simple-high": {"session_type": "quick_question", "complexity": "low", "outcome": "fully_achieved"},
		"complex-low": {"session_type": "multi_task", "complexity": "high", "outcome": "partially_achieved"},
		"failed-high": {"session_type": "single_task", "complexity": "medium", "outcome": "not_achieved"},
		"quota":       {"session_type": "single_task", "complexity": "trivial", "outcome": "mostly_achieved"},
	}
	agg := &metaAggregate{ModelTiers: map[string]string{
		"gpt-5-pro":     "high",
		"gpt-5-mini":    "low",
		"o3":            "high",
		"claude-opus":   "subscription",
		"unknown-model": "",
	}}
	flags, waste := analyzeModelEfficiency(metas, facets, agg)
	if len(flags) != 4 {
		t.Fatalf("flags = %+v", flags)
	}
	if flags[0].SessionID != "simple-high" || flags[0].Flag != "overspend" {
		t.Fatalf("highest cost flag first = %+v", flags[0])
	}
	seen := map[string]string{}
	for _, flag := range flags {
		seen[flag.SessionID] = flag.Flag
	}
	for sessionID, want := range map[string]string{
		"simple-high": "overspend",
		"complex-low": "underspend",
		"failed-high": "overspend",
		"quota":       "quota_pressure",
	} {
		if seen[sessionID] != want {
			t.Errorf("%s flag = %q, want %q", sessionID, seen[sessionID], want)
		}
	}
	if math.Abs(waste-1.45) > 0.0001 {
		t.Errorf("waste = %.4f, want 1.45", waste)
	}
}

func TestRankSessionsForFacetsSkipsCachedAndLimits(t *testing.T) {
	metas := []*sessionMeta{
		{SessionID: "low", DurationSeconds: 10, ToolCounts: map[string]int{"bash": 1}},
		{SessionID: "cached-high", DurationSeconds: 100, ToolCounts: map[string]int{"bash": 4}},
		{SessionID: "high", DurationSeconds: 90, ToolCounts: map[string]int{"bash": 3}},
		{SessionID: "middle", DurationSeconds: 50, ToolCounts: map[string]int{"bash": 2}},
	}
	ranked := rankSessionsForFacets(metas, map[string]map[string]any{"cached-high": {"brief_summary": "done"}}, 2)
	if len(ranked) != 2 {
		t.Fatalf("ranked = %+v", ranked)
	}
	if ranked[0].SessionID != "high" || ranked[1].SessionID != "middle" {
		t.Fatalf("ranked order = %s, %s", ranked[0].SessionID, ranked[1].SessionID)
	}
}

func TestBuildTranscriptsKeepsOnlyNonEmpty(t *testing.T) {
	ch := &transcriptCH{}
	e := &Engine{CH: ch}
	out := e.buildTranscripts(context.Background(), []*sessionMeta{{SessionID: "has-text"}, {SessionID: "empty"}})
	if len(out) != 1 || out["has-text"] != "[User]: do it" {
		t.Fatalf("transcripts = %+v", out)
	}
}

type transcriptCH struct{ mu sync.Mutex }

func (c *transcriptCH) QueryJSON(_ context.Context, _ string, settings clickhouse.Settings) ([]map[string]any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	sid := settings["param_sid"]
	switch sid {
	case "has-text":
		return []map[string]any{{"event_type": "user_prompt", "raw_line": `{"message":{"content":"do it"}}`}}, nil
	case "empty":
		return nil, nil
	default:
		return nil, errors.New("unexpected session")
	}
}

func TestAnalyzeModelEfficiencyLimitsToTwenty(t *testing.T) {
	metas := make([]*sessionMeta, 0, 25)
	facets := map[string]map[string]any{}
	tiers := map[string]string{}
	for i := 0; i < 25; i++ {
		sid := string(rune('a' + i))
		model := "high-" + sid
		metas = append(metas, modelMeta(sid, model, float64(i+1), 5, 1, 60, 1))
		facets[sid] = map[string]any{"session_type": "quick_question", "complexity": "low", "outcome": "fully_achieved"}
		tiers[model] = "high"
	}
	flags, _ := analyzeModelEfficiency(metas, facets, &metaAggregate{ModelTiers: tiers})
	if len(flags) != 20 {
		t.Fatalf("flags = %d, want capped 20", len(flags))
	}
	if flags[0].Cost != 25 || flags[19].Cost != 6 {
		t.Fatalf("flags should be sorted by cost desc: first=%v last=%v", flags[0].Cost, flags[19].Cost)
	}
}

func modelMeta(sessionID, model string, cost float64, messages, userMessages int, duration float64, files int) *sessionMeta {
	return &sessionMeta{
		SessionID:        sessionID,
		StartTime:        "2026-08-30T08:00:00Z",
		UserMessageCount: userMessages,
		DurationSeconds:  duration,
		FilesModified:    files,
		ModelUsage: map[string]*modelUsage{
			model: {Cost: cost, Messages: messages, Sessions: 1},
		},
	}
}

func TestBuildRichMetricsLimitsAndEmbedsVersionData(t *testing.T) {
	agg := metricsAgg()
	versionImpact := map[string]any{
		"canonical_dirty_summary": map[string]any{"winner": "clean"},
		"inspiration_candidates":  []map[string]any{{"layer": "fast"}},
		"isolated_regressions":    []map[string]any{{"layer": "slow"}},
	}
	out := buildRichMetrics(agg, 50, 10, 100, 33.3,
		[]modelEfficiencyFlag{{SessionID: "s1", Flag: "overspend"}}, 12.345,
		map[string]any{"prior_version": "1.0.0"}, versionImpact,
		[]map[string]any{{"name": "reviewer", "status": "used"}})
	if out["active_hours"] != 1.5 || out["total_cost_usd"] != 7.89 || out["estimated_waste_usd"] != 12.35 {
		t.Fatalf("rounded metrics wrong: %+v", out)
	}
	if len(out["top_tools"].([]pair)) != 15 || len(out["top_languages"].([]pair)) != 10 {
		t.Fatalf("top lists were not capped: %+v", out)
	}
	if out["version_comparison_baseline"] == nil || out["canonical_dirty_summary"] == nil {
		t.Fatalf("version comparison data missing: %+v", out)
	}
	if len(out["inspiration_candidates"].([]any)) != 1 || len(out["isolated_regressions"].([]any)) != 1 {
		t.Fatalf("version-impact lists missing: %+v", out)
	}
	modelUsage := out["model_usage"].(map[string]any)
	if modelUsage["gpt-5"].(map[string]any)["tier"] != "high" {
		t.Fatalf("model usage not rendered: %+v", modelUsage)
	}
}

func TestBuildDataBlockRendersSections(t *testing.T) {
	agg := metricsAgg()
	facets := &facetsSummary{
		SessionsWithFacets: 1,
		GoalCategories:     []pair{{Key: "refactor", Count: 2}},
		Outcomes:           map[string]int{"fully_achieved": 1},
		Satisfaction:       map[string]int{"high": 1},
		Helpfulness:        map[string]int{"helpful": 1},
		SessionTypes:       map[string]int{"multi_task": 1},
		Complexity:         map[string]int{"high": 1},
		FrictionTypes:      []pair{{Key: "tooling", Count: 1}},
		SuccessFactors:     []pair{{Key: "tests", Count: 1}},
		RepeatedInstructions: []map[string]any{
			{"instruction": "always run tests", "frequency": 3},
		},
	}
	allFacets := []map[string]any{{
		"brief_summary":         "Fixed a flaky parser",
		"outcome":               "fully_achieved",
		"agent_helpfulness":     "helpful",
		"friction_points":       []any{map[string]any{"type": "tooling", "description": "cache was stale"}},
		"repeated_instructions": []any{"prefer focused tests"},
	}}
	block := buildDataBlock("Helper", agg, facets, allFacets, "2026-08-01", "2026-08-30",
		map[string]any{"configured_skills": []any{"reviewer"}},
		[]modelEfficiencyFlag{{Flag: "overspend", Model: "gpt-5", Date: "2026-08-30", Cost: 1.23, Complexity: "low", SessionType: "quick_question", Outcome: "fully_achieved", Reason: "too much model"}},
		1.23, []map[string]any{{"name": "reviewer", "status": "used"}})
	for _, want := range []string{
		`"agent": "Helper"`,
		`"cache_hit_rate_pct"`,
		"## Agent Configuration",
		"SESSION SUMMARIES:",
		"FRICTION DETAILS:",
		"USER INSTRUCTIONS TO ASSISTANT:",
		"REPEATED INSTRUCTIONS (by frequency):",
		"COMPONENT UTILIZATION:",
		"MODEL EFFICIENCY FLAGS:",
		"Estimated waste from model mismatch: $1.23",
	} {
		if !strings.Contains(block, want) {
			t.Fatalf("data block missing %q:\n%s", want, block)
		}
	}
}

func metricsAgg() *metaAggregate {
	topTools := make([]pair, 16)
	for i := range topTools {
		topTools[i] = pair{Key: "tool", Count: 20 - i}
	}
	topLanguages := make([]pair, 11)
	for i := range topLanguages {
		topLanguages[i] = pair{Key: "lang", Count: 12 - i}
	}
	toolErrors := newOrderedCount()
	toolErrors.add("timeout", 2)
	projects := newOrderedCount()
	projects.add("/repo", 1)
	return &metaAggregate{
		TotalSessions:       3,
		TotalMessages:       10,
		TotalDurationHours:  1.49,
		TotalInputTokens:    100,
		TotalOutputTokens:   40,
		TotalCacheReadToks:  50,
		TotalCacheWriteToks: 10,
		TotalCost:           7.891,
		TotalCredits:        1.23456,
		TotalLinesAdded:     30,
		TotalLinesRemoved:   5,
		TotalFilesModified:  4,
		GitCommits:          2,
		GitPushes:           1,
		TotalToolErrors:     2,
		TotalInterruptions:  1,
		SessionsUsingSubag:  1,
		SessionsUsingMCP:    2,
		ToolErrorCategories: toolErrors,
		Projects:            projects,
		DaysActive:          2,
		Harnesses:           []string{"copilot"},
		SessionsWithTokens:  3,
		SessionsWithCredits: 2,
		ModelUsage: map[string]*modelUsage{
			"gpt-5": {Cost: 7.891, Messages: 10, Sessions: 3, Tier: "high", CostPer1K: 0.0123},
		},
		modelOrder:   []string{"gpt-5"},
		ModelTiers:   map[string]string{"gpt-5": "high"},
		TopTools:     topTools,
		TopLanguages: topLanguages,
	}
}
