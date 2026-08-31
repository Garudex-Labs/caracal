// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harness

import "testing"

// TestAgentSupportMapping locks the evidence-based agent support level and
// multi-agent semantics for every registered harness, so a false native
// capability claim cannot be introduced unnoticed. "native" means a documented,
// separately selectable named agent/subagent; "compatible" means a valid but
// non-primary mechanism (rules, profiles, or an instruction file the harness
// loads without listing it as a distinct selectable agent).
func TestAgentSupportMapping(t *testing.T) {
	reg := MustLoad()
	want := map[string]struct {
		support string
		multi   bool
	}{
		"claude-code": {"native", true},
		"kiro":        {"native", true},
		"copilot":     {"native", true},
		"copilot-cli": {"native", true},
		"opencode":    {"native", true},
		"cursor":      {"compatible", true},
		"codex":       {"compatible", true},
		"goose":       {"compatible", true},
		"antigravity": {"compatible", true},
		"pi":          {"compatible", false},
	}
	for _, name := range reg.Names() {
		spec, _ := reg.Spec(name)
		w, ok := want[name]
		if !ok {
			t.Fatalf("harness %q has no expected agent classification; classify it before adding", name)
		}
		if spec.AgentSupport != w.support {
			t.Errorf("%s AgentSupport = %q, want %q", name, spec.AgentSupport, w.support)
		}
		if spec.AgentMechanism == "" {
			t.Errorf("%s AgentMechanism empty for a supported harness", name)
		}
		if !spec.SupportsAgents() {
			t.Errorf("%s SupportsAgents() = false, want true", name)
		}
		if spec.IsMultiAgent() != w.multi {
			t.Errorf("%s IsMultiAgent() = %v, want %v", name, spec.IsMultiAgent(), w.multi)
		}
	}
}

// TestEmptySpecAgentUnsupported confirms a harness with no declared agent
// support fails closed rather than defaulting to supported.
func TestEmptySpecAgentUnsupported(t *testing.T) {
	var s Spec
	if s.SupportsAgents() {
		t.Errorf("empty spec SupportsAgents() = true, want false")
	}
	if s.IsMultiAgent() {
		t.Errorf("empty spec IsMultiAgent() = true, want false")
	}
}
