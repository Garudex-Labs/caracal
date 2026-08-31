// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harness

import (
	"slices"
	"testing"
)

// Canonical declaration order from packages/harness-data/registry.json; the
// CLI and API rely on this order being stable.
var wantNames = []string{
	"cursor", "kiro", "claude-code", "codex", "copilot",
	"copilot-cli", "opencode", "antigravity", "goose", "pi",
}

func TestLoadNamesInDeclarationOrder(t *testing.T) {
	r := MustLoad()
	if got := r.Names(); !slices.Equal(got, wantNames) {
		t.Fatalf("Names() = %v, want %v", got, wantNames)
	}
}

func TestSessionParserMapping(t *testing.T) {
	want := map[string]string{
		"cursor":      "cursor",
		"kiro":        "kiro",
		"claude-code": "claude-code",
		"codex":       "codex",
		"copilot":     "copilot-cli", // Copilot reuses the Copilot CLI parser
		"copilot-cli": "copilot-cli",
		"opencode":    "opencode",
		"antigravity": "antigravity",
		"goose":       "goose",
		"pi":          "pi",
	}
	r := MustLoad()
	for name, parser := range want {
		got, err := r.SessionParserID(name)
		if err != nil {
			t.Fatalf("SessionParserID(%q): %v", name, err)
		}
		if got != parser {
			t.Errorf("SessionParserID(%q) = %q, want %q", name, got, parser)
		}
	}
	if _, err := r.SessionParserID("no-such-harness"); err == nil {
		t.Error("SessionParserID with unknown harness: want error, got nil")
	}
}

// TestSkillCapabilityMatchesMechanism guards the two skill representations from
// drifting: the "skills" capability must be present exactly when the harness
// materializes a native Agent Skill (SKILL.md).
func TestSkillCapabilityMatchesMechanism(t *testing.T) {
	r := MustLoad()
	for _, name := range r.Names() {
		spec, _ := r.Spec(name)
		if spec.HasCapability(CapSkills) != spec.EmitsSkillMd() {
			t.Errorf("%s: capabilities.skills=%v but EmitsSkillMd=%v (skill_mechanism=%q)",
				name, spec.HasCapability(CapSkills), spec.EmitsSkillMd(), spec.SkillMechanism)
		}
		// skill_support is the human label; it must be one of the two honest
		// states and agree with the materialization gate.
		switch spec.SkillSupport {
		case "native":
			if !spec.EmitsSkillMd() {
				t.Errorf("%s: skill_support=native but does not emit SKILL.md", name)
			}
		case "unsupported":
			if spec.EmitsSkillMd() {
				t.Errorf("%s: skill_support=unsupported but emits SKILL.md", name)
			}
		default:
			t.Errorf("%s: skill_support=%q must be native or unsupported", name, spec.SkillSupport)
		}
	}
}

func TestSpecFields(t *testing.T) {
	r := MustLoad()

	tests := []struct {
		name  string
		check func(t *testing.T, s *Spec)
	}{
		{"claude-code", func(t *testing.T, s *Spec) {
			if s.DisplayName != "Claude Code" {
				t.Errorf("DisplayName = %q", s.DisplayName)
			}
			for _, c := range []Capability{CapHooks, CapMCPServers, CapSkills} {
				if !s.HasCapability(c) {
					t.Errorf("missing capability %q", c)
				}
			}
			if s.PromptMode() != PromptNative {
				t.Errorf("claude-code prompt mode = %q, want native", s.PromptMode())
			}
			if s.Hooks["user"] != "~/.claude/settings.json" {
				t.Errorf("Hooks[user] = %q", s.Hooks["user"])
			}
		}},
		{"copilot-cli", func(t *testing.T, s *Spec) {
			if s.PromptMode() != PromptEmbedded {
				t.Errorf("copilot-cli prompt mode = %q, want embedded", s.PromptMode())
			}
			if got := s.HookEventsMap["Stop"]; got != "sessionEnd" {
				t.Errorf("HookEventsMap[Stop] = %q, want sessionEnd", got)
			}
		}},
		{"goose", func(t *testing.T, s *Spec) {
			if s.HomeMCPConfig != "~/.config/goose/config.yaml" {
				t.Errorf("HomeMCPConfig = %q", s.HomeMCPConfig)
			}
			if s.MCPServersKey != "extensions" {
				t.Errorf("MCPServersKey = %q", s.MCPServersKey)
			}
		}},
		{"pi", func(t *testing.T, s *Spec) {
			if len(s.HookEventsMap) != 0 {
				t.Errorf("pi HookEventsMap should be empty, got %v", s.HookEventsMap)
			}
			if s.HookType != "extension" {
				t.Errorf("HookType = %q", s.HookType)
			}
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s, ok := r.Spec(tc.name)
			if !ok {
				t.Fatalf("Spec(%q) not found", tc.name)
			}
			tc.check(t, s)
		})
	}
}

func TestEveryHarnessHasRequiredFields(t *testing.T) {
	r := MustLoad()
	for _, name := range r.Names() {
		s, _ := r.Spec(name)
		if s.DisplayName == "" {
			t.Errorf("%s: empty display_name", name)
		}
		if len(s.Capabilities) == 0 {
			t.Errorf("%s: no capabilities", name)
		}
		if !slices.Contains(s.Scopes, s.DefaultScope) {
			t.Errorf("%s: default_scope %q not in scopes %v", name, s.DefaultScope, s.Scopes)
		}
		if s.ScopeLabels != nil && len(s.ScopeLabels) != 2 {
			t.Errorf("%s: scope_labels must have 2 entries, got %v", name, s.ScopeLabels)
		}
		for _, scope := range s.Scopes {
			if _, ok := s.AgentProfile[scope]; !ok {
				t.Errorf("%s: scope %q missing from agent_profile", name, scope)
			}
		}
	}
}
