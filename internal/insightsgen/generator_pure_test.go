// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"errors"
	"testing"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

func TestContainsAnyOf(t *testing.T) {
	if !containsAnyOf("the quick brown fox", "slow", "quick") {
		t.Error("should match when any needle is present")
	}
	if containsAnyOf("the quick brown fox", "cat", "dog") {
		t.Error("should not match when no needle is present")
	}
	if containsAnyOf("anything") {
		t.Error("no needles should never match")
	}
}

func TestLimitPairs(t *testing.T) {
	in := []pair{{Key: "a"}, {Key: "b"}, {Key: "c"}}
	if got := limitPairs(in, 2); len(got) != 2 || got[1].Key != "b" {
		t.Errorf("over-limit truncates to prefix: %+v", got)
	}
	if got := limitPairs(in, 5); len(got) != 3 {
		t.Errorf("under-limit returns everything: %+v", got)
	}
}

func TestNumericHelpers(t *testing.T) {
	if max64(3, 7) != 7 || max64(9, 2) != 9 {
		t.Error("max64")
	}
	if maxFloat(1.5, 0.5) != 1.5 || maxFloat(0.1, 2.2) != 2.2 {
		t.Error("maxFloat")
	}
	if minFloat(1.5, 0.5) != 0.5 || minFloat(0.1, 2.2) != 0.1 {
		t.Error("minFloat")
	}
}

func TestPinnedVersions(t *testing.T) {
	pinned := map[string]any{"tool": "1.2.3"}
	if got := pinnedVersions(map[string]any{"pinned_versions": pinned}); got["tool"] != "1.2.3" {
		t.Errorf("should pass through the pinned map: %+v", got)
	}
	if got := pinnedVersions(map[string]any{}); got == nil || len(got) != 0 {
		t.Errorf("absent key yields an empty non-nil map: %+v", got)
	}
	if got := pinnedVersions(map[string]any{"pinned_versions": "notamap"}); len(got) != 0 {
		t.Errorf("non-map value yields empty: %+v", got)
	}
}

func TestAggregateSummaryMapShape(t *testing.T) {
	agg := aggregateMetas([]*sessionMeta{})
	m := aggregateSummaryMap(agg)
	if m["total_sessions"] != 0 {
		t.Errorf("total_sessions = %v, want 0", m["total_sessions"])
	}
	for _, key := range []string{"model_usage", "top_tools", "projects", "model_tiers"} {
		if _, ok := m[key]; !ok {
			t.Errorf("summary is missing %q", key)
		}
	}
}

func TestAnalyzeComponentUtilization(t *testing.T) {
	agentConfig := map[string]any{
		"configured_skills": []any{"code-review"},
		"configured_hooks":  []any{"lint-gate"},
	}
	metas := []*sessionMeta{
		{FirstPrompt: "please run a code review on this", ToolCounts: map[string]int{"bash": 1}},
	}
	out := analyzeComponentUtilization(agentConfig, metas, nil)
	if len(out) != 2 {
		t.Fatalf("expected one row per component, got %d", len(out))
	}
	var skill map[string]any
	for _, row := range out {
		if row["type"] == "skill" {
			skill = row
		}
	}
	// "code-review" -> "code review" appears in the prompt, so it is observed.
	if skill["status"] != "used" || skill["confidence"] != "medium" {
		t.Errorf("mentioned skill should be used/medium: %+v", skill)
	}
}

func TestAnalyzeComponentUtilizationNoComponents(t *testing.T) {
	if got := analyzeComponentUtilization(nil, nil, nil); len(got) != 0 {
		t.Errorf("no configured components yields an empty slice: %+v", got)
	}
}

func TestDetectLayerGroupsParsesRows(t *testing.T) {
	ch := &fakeCH{fn: func(_ int, _ string, settings clickhouse.Settings) ([]map[string]any, error) {
		if settings["param_agent_id"] != "aid" {
			return nil, errors.New("missing agent id param")
		}
		return []map[string]any{{
			"agent_version":        "1.2.0",
			"layer_hash":           "abc",
			"sessions":             "10",
			"users":                "3",
			"avg_prompts":          "5.4",
			"avg_tool_calls":       "2.2",
			"avg_duration_seconds": "120",
			"avg_cost":             "0.1234",
			"avg_tokens":           "500",
			"tool_error_rate":      "0.125",
			"success_proxy":        "0.9",
		}}, nil
	}}
	e := &Engine{CH: ch}
	groups := e.detectLayerGroups(context.Background(), "aid", "aname", "start", "end", "1.2.0")
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1", len(groups))
	}
	g := groups[0]
	if g.LayerHash != "abc" || g.Sessions != 10 || g.Users != 3 {
		t.Errorf("scalar fields = %+v", g)
	}
	if g.AvgPrompts != 5.4 || g.ToolErrorRate != 0.125 || g.SuccessProxy != 0.9 {
		t.Errorf("rounded float fields = %+v", g)
	}
}

func TestDetectLayerGroupsQueryErrorIsNil(t *testing.T) {
	ch := &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, errors.New("clickhouse down")
	}}
	e := &Engine{CH: ch}
	if got := e.detectLayerGroups(context.Background(), "aid", "aname", "s", "e", ""); got != nil {
		t.Errorf("a failed query returns nil, got %+v", got)
	}
}
