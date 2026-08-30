// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"errors"
	"testing"
)

func TestBuildSignalsPrioritizesOperationalRisk(t *testing.T) {
	metrics := []briefingMetric{
		{Key: "sessions", Value: workspaceFloatPointer(100), Previous: workspaceFloatPointer(98), ChangePct: workspaceFloatPointer(2)},
		{Key: "credits", Value: workspaceFloatPointer(20), Previous: workspaceFloatPointer(10), ChangePct: workspaceFloatPointer(100)},
	}
	resources := []workspaceResource{{
		AgentID: "agent-1", Name: "Reviewer", Sessions: workspaceIntPointer(40), OpenIssues: workspaceIntPointer(4),
		ToolCalls: workspaceIntPointer(50), ToolCompletionPct: workspaceFloatPointer(60),
		AttentionReasons: []string{"open review issues", "low tool completion"},
	}}
	signals := buildSignals(metrics, resources)
	if len(signals) != 2 {
		t.Fatalf("signals = %+v", signals)
	}
	if signals[0].Kind != "resource_attention" || signals[0].Severity != "critical" {
		t.Fatalf("first signal = %+v", signals[0])
	}
	if signals[1].Kind != "cost_divergence" {
		t.Fatalf("second signal = %+v", signals[1])
	}
}

func TestFilterAndSortResourceRows(t *testing.T) {
	rows := []workspaceResource{
		{AgentID: "a", Name: "Alpha", Sessions: workspaceIntPointer(2), ChangePct: workspaceFloatPointer(-50), AttentionReasons: []string{"declining usage"}},
		{AgentID: "b", Name: "Beta", Sessions: workspaceIntPointer(20), ChangePct: workspaceFloatPointer(80), AttentionReasons: []string{}},
		{AgentID: "c", Name: "Gamma", Sessions: workspaceIntPointer(0), Downloads: workspaceIntPointer(5), AttentionReasons: []string{"installed but unused"}},
	}
	declining := filterResourceRows(rows, "declining", "")
	if len(declining) != 1 || declining[0].AgentID != "a" {
		t.Fatalf("declining = %+v", declining)
	}
	underused := filterResourceRows(rows, "underused", "")
	if len(underused) != 1 || underused[0].AgentID != "c" {
		t.Fatalf("underused = %+v", underused)
	}
	sortResourceRows(rows, "growth")
	if rows[0].AgentID != "b" || rows[1].AgentID != "a" || rows[2].AgentID != "c" {
		t.Fatalf("growth order = %+v", rows)
	}
}

func TestDailyShiftEventsDistinguishesUsageAndCost(t *testing.T) {
	rows := []map[string]any{
		{"day": "2026-08-27", "sessions": "10", "credits": "2"},
		{"day": "2026-08-28", "sessions": "20", "credits": "4"},
	}
	events := dailyShiftEvents(rows, true)
	if len(events) != 2 || events[0].Category != "usage" || events[1].Category != "cost" {
		t.Fatalf("events = %+v", events)
	}
}

func TestUnavailableTelemetryDoesNotBecomeZero(t *testing.T) {
	row := workspaceResource{AgentID: "a", Name: "Alpha"}
	applyResourceMetrics(&row, nil, errors.New("offline"), true)
	if row.Sessions != nil || row.ToolCalls != nil || row.Credits != nil {
		t.Fatalf("unavailable telemetry must remain nil: %+v", row)
	}
}

func TestDailyShiftEventsHideCostWithoutPermission(t *testing.T) {
	rows := []map[string]any{
		{"day": "2026-08-27", "sessions": "10", "credits": "2"},
		{"day": "2026-08-28", "sessions": "20", "credits": "4"},
	}
	events := dailyShiftEvents(rows, false)
	if len(events) != 1 || events[0].Category != "usage" {
		t.Fatalf("events = %+v", events)
	}
}

func TestPercentChange(t *testing.T) {
	if workspacePercentChange(10, 0) != nil {
		t.Fatal("zero baseline must return nil")
	}
	if value := workspacePercentChange(15, 10); value == nil || *value != 50 {
		t.Fatalf("change = %v", value)
	}
}
