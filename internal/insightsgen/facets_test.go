// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"reflect"
	"testing"
)

func TestAggregateFacetsEmptyInput(t *testing.T) {
	if got := aggregateFacets(nil); got != nil {
		t.Errorf("no facets must aggregate to nil, got %+v", got)
	}
}

func TestAggregateFacets(t *testing.T) {
	facets := []map[string]any{
		{
			"goal_categories":         []any{"debugging", "testing"},
			"outcome":                 "success",
			"user_satisfaction":       "satisfied",
			"agent_helpfulness":       "very_helpful",
			"session_type":            "multi_task",
			"complexity":              "low",
			"friction_points":         []any{map[string]any{"type": "tool_error"}, "not-a-map"},
			"primary_success_factors": []any{"fast iteration"},
			"tools_effective":         []any{"grep"},
			"tools_problematic":       []any{map[string]any{"tool": "browser"}},
			"repeated_instructions":   []any{"Use tabs"},
		},
		{
			"goal_categories":       []any{"debugging"},
			"repeated_instructions": []any{"  use tabs "},
		},
		{}, // sessions without facets still count toward the total
	}
	got := aggregateFacets(facets)
	if got.SessionsWithFacets != 3 {
		t.Errorf("SessionsWithFacets = %d, want 3", got.SessionsWithFacets)
	}
	if want := []pair{{"debugging", 2}, {"testing", 1}}; !reflect.DeepEqual(got.GoalCategories, want) {
		t.Errorf("GoalCategories = %v, want %v", got.GoalCategories, want)
	}
	if got.Outcomes["success"] != 1 || got.Outcomes["unclear"] != 1 {
		t.Errorf("missing outcome must default to unclear: %v", got.Outcomes)
	}
	if got.Satisfaction["satisfied"] != 1 || got.Satisfaction["unsure"] != 1 {
		t.Errorf("missing satisfaction must default to unsure: %v", got.Satisfaction)
	}
	if got.SessionTypes["multi_task"] != 1 || got.SessionTypes["single_task"] != 1 {
		t.Errorf("missing session type must default to single_task: %v", got.SessionTypes)
	}
	if got.Complexity["low"] != 1 || got.Complexity["medium"] != 1 {
		t.Errorf("missing complexity must default to medium: %v", got.Complexity)
	}
	if want := []pair{{"tool_error", 1}}; !reflect.DeepEqual(got.FrictionTypes, want) {
		t.Errorf("FrictionTypes = %v (non-map friction entries must be skipped)", got.FrictionTypes)
	}
	if want := []pair{{"browser", 1}}; !reflect.DeepEqual(got.ToolsProblematic, want) {
		t.Errorf("ToolsProblematic = %v, want %v", got.ToolsProblematic, want)
	}
	// Repeated instructions normalize case and whitespace, and only
	// surface when seen at least twice.
	if len(got.RepeatedInstructions) != 1 {
		t.Fatalf("RepeatedInstructions = %v", got.RepeatedInstructions)
	}
	entry := got.RepeatedInstructions[0]
	if entry["instruction"] != "use tabs" || entry["frequency"] != 2 {
		t.Errorf("normalized instruction = %v", entry)
	}
}

func TestAggregateFacetsDropsSingleOccurrenceInstructions(t *testing.T) {
	got := aggregateFacets([]map[string]any{
		{"repeated_instructions": []any{"only once"}},
	})
	if len(got.RepeatedInstructions) != 0 {
		t.Errorf("single occurrence must not be reported: %v", got.RepeatedInstructions)
	}
}
