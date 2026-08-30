// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"reflect"
	"strings"
	"testing"
)

func TestMedian(t *testing.T) {
	cases := []struct {
		in   []float64
		want float64
	}{
		{nil, 0},
		{[]float64{5}, 5},
		{[]float64{3, 1, 2}, 2},
		{[]float64{4, 1, 3, 2}, 2.5},
	}
	for _, tc := range cases {
		if got := median(tc.in); got != tc.want {
			t.Errorf("median(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
	// The input slice must not be reordered.
	in := []float64{3, 1, 2}
	median(in)
	if !reflect.DeepEqual(in, []float64{3, 1, 2}) {
		t.Errorf("median mutated its input: %v", in)
	}
}

func TestRobustOutlierLabels(t *testing.T) {
	small := []layerGroup{{LayerHash: "aa"}, {LayerHash: "bb"}}
	labels := robustOutlierLabels(small)
	if labels["aa"] != "normal" || labels["bb"] != "normal" {
		t.Errorf("fewer than three cohorts must all be normal: %v", labels)
	}

	groups := []layerGroup{
		{LayerHash: "n1", SuccessProxy: 0.5},
		{LayerHash: "n2", SuccessProxy: 0.5},
		{LayerHash: "n3", SuccessProxy: 0.5},
		{LayerHash: "n4", SuccessProxy: 0.5},
		{LayerHash: "hi", SuccessProxy: 0.9},
		{LayerHash: "lo", SuccessProxy: 0.1},
	}
	labels = robustOutlierLabels(groups)
	if labels["hi"] != "positive_outlier" {
		t.Errorf("hi = %q", labels["hi"])
	}
	if labels["lo"] != "negative_outlier" {
		t.Errorf("lo = %q", labels["lo"])
	}
	for _, h := range []string{"n1", "n2", "n3", "n4"} {
		if labels[h] != "normal" {
			t.Errorf("%s = %q, want normal", h, labels[h])
		}
	}
}

func TestConfidenceForGroups(t *testing.T) {
	multi := func(sessions, users int) layerGroup { return layerGroup{Sessions: sessions, Users: users} }
	cases := []struct {
		name        string
		groups      []layerGroup
		significant bool
		want        string
	}{
		{"too few sessions", []layerGroup{multi(4, 2), multi(5, 2)}, true, "insufficient_data"},
		{"single cohort", []layerGroup{multi(50, 5)}, true, "insufficient_data"},
		{"high", []layerGroup{multi(20, 3), multi(15, 2)}, true, "high"},
		{"medium when one cohort is single-user", []layerGroup{multi(20, 3), multi(15, 1)}, true, "medium"},
		{"medium on moderate volume", []layerGroup{multi(10, 1), multi(6, 1)}, true, "medium"},
		{"low when not significant", []layerGroup{multi(20, 3), multi(15, 2)}, false, "low"},
	}
	for _, tc := range cases {
		if got := confidenceForGroups(tc.groups, tc.significant); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func snap(files map[string][]map[string]any) map[string]any {
	harnesses := map[string]any{}
	for harness, list := range files {
		items := make([]any, 0, len(list))
		for _, f := range list {
			items = append(items, f)
		}
		harnesses[harness] = items
	}
	return map[string]any{"harnesses": harnesses}
}

func TestSnapshotFiles(t *testing.T) {
	s := snap(map[string][]map[string]any{
		"claude-code": {{"path": "CLAUDE.md", "hash": "h1"}, {"path": "agents/dev.md", "hash": "h2"}},
		"kiro":        {{"path": "steering.md", "hash": "h3"}},
	})
	got := snapshotFiles(s)
	want := map[string]string{
		"claude-code/CLAUDE.md":     "h1",
		"claude-code/agents/dev.md": "h2",
		"kiro/steering.md":          "h3",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("snapshotFiles = %v, want %v", got, want)
	}
	if got := snapshotFiles(map[string]any{}); len(got) != 0 {
		t.Errorf("empty snapshot: %v", got)
	}
}

func TestDiffSnapshots(t *testing.T) {
	a := snap(map[string][]map[string]any{
		"claude-code": {
			{"path": "CLAUDE.md", "hash": "h1"},
			{"path": "removed.md", "hash": "h2"},
			{"path": "same.md", "hash": "h3"},
		},
	})
	b := snap(map[string][]map[string]any{
		"claude-code": {
			{"path": "CLAUDE.md", "hash": "CHANGED"},
			{"path": "same.md", "hash": "h3"},
			{"path": "new.md", "hash": "h4"},
		},
	})
	got := diffSnapshots(a, b)
	if !reflect.DeepEqual(got["added"], []string{"claude-code/new.md"}) {
		t.Errorf("added = %v", got["added"])
	}
	if !reflect.DeepEqual(got["removed"], []string{"claude-code/removed.md"}) {
		t.Errorf("removed = %v", got["removed"])
	}
	if !reflect.DeepEqual(got["modified"], []string{"claude-code/CLAUDE.md"}) {
		t.Errorf("modified = %v", got["modified"])
	}
}

func TestExtractContentSummary(t *testing.T) {
	nonBehavioral := snap(map[string][]map[string]any{
		"claude-code": {{"path": "settings.json", "hash": "h", "content": "{}"}},
	})
	if got := extractContentSummary(nonBehavioral); got != "(no behavioral content captured)" {
		t.Errorf("non-behavioral snapshot: %q", got)
	}

	behavioral := snap(map[string][]map[string]any{
		"claude-code": {
			{"path": "CLAUDE.md", "hash": "h", "content": strings.Repeat("x", 600)},
			{"path": "settings.json", "hash": "h", "content": "{}"},
		},
	})
	got := extractContentSummary(behavioral)
	if !strings.HasPrefix(got, "[claude-code:CLAUDE.md]\n") {
		t.Errorf("missing header: %q", got[:40])
	}
	if strings.Count(got, "x") != 500 {
		t.Errorf("snippet not truncated to 500 chars: %d", strings.Count(got, "x"))
	}
	if strings.Contains(got, "settings.json") {
		t.Error("non-behavioral file leaked into the summary")
	}
}

func TestSnapshotCanonical(t *testing.T) {
	if got := snapshotCanonical(map[string]any{}); got != nil {
		t.Errorf("no drift block: %v", got)
	}
	if got := snapshotCanonical(map[string]any{"drift": map[string]any{}}); got != nil {
		t.Errorf("drift without the key: %v", got)
	}
	if got := snapshotCanonical(map[string]any{"drift": map[string]any{"is_canonical": false}}); got != false {
		t.Errorf("explicit false must survive: %v", got)
	}
}
