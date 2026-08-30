// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"strings"
	"sync"
	"testing"
)

// recordingCompleter captures every model call and answers from a script.
type recordingCompleter struct {
	mu      sync.Mutex
	calls   []completerCall
	respond func(prompt, model string, maxTokens int) (map[string]any, error)
}

type completerCall struct {
	prompt    string
	model     string
	maxTokens int
}

func (r *recordingCompleter) Complete(_ context.Context, prompt, model string, maxTokens int) (map[string]any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, completerCall{prompt, model, maxTokens})
	if r.respond != nil {
		return r.respond(prompt, model, maxTokens)
	}
	return map[string]any{"echo": "ok"}, nil
}

func (r *recordingCompleter) snapshot() []completerCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]completerCall{}, r.calls...)
}

func TestBuildSectionPrompts(t *testing.T) {
	prompts := buildSectionPrompts("DATA-MARKER", "PREV-MARKER", "\nOFFER-MARKER")
	if len(prompts) != len(sectionPrompts) {
		t.Fatalf("prompts = %d, want %d", len(prompts), len(sectionPrompts))
	}
	for name, prompt := range prompts {
		if !strings.HasPrefix(prompt, sectionPreamble) {
			t.Errorf("%s missing preamble", name)
		}
		if !strings.Contains(prompt, "DATA-MARKER") {
			t.Errorf("%s missing data block", name)
		}
		if strings.Contains(prompt, "{data_block}") || strings.Contains(prompt, "{previous_data_block}") {
			t.Errorf("%s has unsubstituted placeholder", name)
		}
		if name != "suggestions" && strings.Contains(prompt, "OFFER-MARKER") {
			t.Errorf("%s must not receive the catalog offer", name)
		}
		if name != "regression_detection" && strings.Contains(prompt, "PREV-MARKER") {
			t.Errorf("%s must not receive the previous data block", name)
		}
	}
	if !strings.Contains(prompts["suggestions"], "DATA-MARKER\nOFFER-MARKER") {
		t.Error("suggestions must append the offer right after the data block")
	}
	if !strings.Contains(prompts["regression_detection"], "PREV-MARKER") {
		t.Error("regression_detection must receive the previous data block")
	}
}

func TestUnwrapSection(t *testing.T) {
	payload := map[string]any{"narrative": "n"}
	if got := unwrapSection("usage_patterns", map[string]any{"usage_patterns": payload}); got.(map[string]any)["narrative"] != "n" {
		t.Errorf("expected key: %v", got)
	}
	if got := unwrapSection("usage_patterns", map[string]any{"other": "v"}); got != "v" {
		t.Errorf("single foreign key: %v", got)
	}
	// Several foreign keys resolve to the lexicographically first one.
	if got := unwrapSection("x", map[string]any{"zeta": 1, "alpha": 2}); got != 2 {
		t.Errorf("multi foreign key: %v", got)
	}
	empty := unwrapSection("fun_ending", map[string]any{})
	if m := empty.(map[string]any); m["headline"] != "" || m["detail"] != "" {
		t.Errorf("empty fun_ending fallback: %v", empty)
	}
	if m := unwrapSection("what_works", map[string]any{}).(map[string]any); len(m) != 0 {
		t.Errorf("empty section fallback: %v", m)
	}
}

func TestOrDefault(t *testing.T) {
	if orDefault("") != "default" || orDefault("gpt-5") != "gpt-5" {
		t.Error("orDefault")
	}
}

func TestGenerateSections(t *testing.T) {
	llm := &recordingCompleter{}
	e := &Engine{
		Config: &Config{Settings: fakeSettings{
			"insights.model_sections":  "deep-model",
			"insights.model_synthesis": "fast-model",
		}},
		LLM: llm,
	}
	narrative := e.generateSections(context.Background(), "DATA", nil, nil)

	if len(narrative) != len(sectionPrompts)+1 {
		t.Fatalf("narrative keys = %d, want %d", len(narrative), len(sectionPrompts)+1)
	}
	for name := range sectionPrompts {
		if narrative[name] != "ok" {
			t.Errorf("section %s = %v", name, narrative[name])
		}
	}
	if narrative["at_a_glance"] != "ok" {
		t.Errorf("at_a_glance = %v", narrative["at_a_glance"])
	}

	calls := llm.snapshot()
	if len(calls) != len(sectionPrompts)+1 {
		t.Fatalf("model calls = %d", len(calls))
	}
	deep, fast := 0, 0
	tokenCounts := map[int]int{}
	var synthesisPromptSeen string
	for _, c := range calls {
		switch c.model {
		case "deep-model":
			deep++
		case "fast-model":
			fast++
		default:
			t.Errorf("unexpected model %q", c.model)
		}
		tokenCounts[c.maxTokens]++
		if c.maxTokens == 4096 {
			synthesisPromptSeen = c.prompt
		}
	}
	if deep != len(deepSections) {
		t.Errorf("deep model calls = %d, want %d", deep, len(deepSections))
	}
	if fast != len(sectionPrompts)-len(deepSections)+1 {
		t.Errorf("fast model calls = %d", fast)
	}
	if tokenCounts[1024] != 1 || tokenCounts[4096] != 1 || tokenCounts[defaultSectionTokens] != len(sectionPrompts)-1 {
		t.Errorf("token budgets = %v", tokenCounts)
	}
	// Synthesis runs after the sections and sees their outputs.
	if !strings.Contains(synthesisPromptSeen, `"friction_analysis": "ok"`) {
		t.Error("synthesis prompt missing section outputs")
	}
	if !strings.Contains(synthesisPromptSeen, "DATA") {
		t.Error("synthesis prompt missing data block")
	}
}

func TestGenerateSectionsDegradesOnEmptyModelOutput(t *testing.T) {
	llm := &recordingCompleter{respond: func(string, string, int) (map[string]any, error) {
		return map[string]any{}, nil
	}}
	e := &Engine{
		Config: &Config{Settings: fakeSettings{"insights.model_sections": "m"}},
		LLM:    llm,
	}
	narrative := e.generateSections(context.Background(), "DATA", nil, nil)
	if m := narrative["fun_ending"].(map[string]any); m["headline"] != "" {
		t.Errorf("fun_ending fallback = %v", narrative["fun_ending"])
	}
	if m := narrative["what_works"].(map[string]any); len(m) != 0 {
		t.Errorf("what_works fallback = %v", narrative["what_works"])
	}
	if m := narrative["at_a_glance"].(map[string]any); len(m) != 0 {
		t.Errorf("at_a_glance fallback = %v", narrative["at_a_glance"])
	}
}

func TestGenerateSectionsIncludesPreviousReport(t *testing.T) {
	llm := &recordingCompleter{}
	e := &Engine{
		Config: &Config{Settings: fakeSettings{"insights.model_sections": "m"}},
		LLM:    llm,
	}
	e.generateSections(context.Background(), "DATA", map[string]any{"prev_marker": "prior period"}, nil)
	var regressionPrompt string
	for _, c := range llm.snapshot() {
		if strings.Contains(c.prompt, "Compare current and previous period metrics") {
			regressionPrompt = c.prompt
		}
	}
	if regressionPrompt == "" {
		t.Fatal("regression prompt not issued")
	}
	if !strings.Contains(regressionPrompt, "prev_marker") || !strings.Contains(regressionPrompt, "prior period") {
		t.Error("regression prompt missing previous report data")
	}
}
