// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"encoding/json"
	"strings"
	"testing"
)

func testRequest(harnessName string) *Request {
	return &Request{
		Agent: &Agent{
			ID: "0656308f-8bba-472e-ab77-f96a7ac69fd2", Name: "Review Bot", Slug: "review-bot",
			Description: "Automated code review helper", Prompt: "You review code.",
			ModelName: "claude-sonnet-4-5",
			Components: []ComponentLink{
				{Type: "mcp", ID: "m1", OrderIndex: 0},
				{Type: "skill", ID: "s1", OrderIndex: 1},
			},
		},
		Harness:    harnessName,
		CaracalURL: "http://localhost:8080",
		McpListings: map[string]Listing{"m1": {
			"name": "Weather Fetcher", "slug": "weather-fetcher", "namespace": "acme",
			"status": "approved", "description": "Fetches weather forecasts",
		}},
		SkillListings: map[string]Listing{"s1": {
			"name": "Code Reviewer", "slug": "code-reviewer", "namespace": "acme",
			"status": "approved", "description": "Reviews pull requests",
			"task_type": "review", "skill_path": "/reviewer",
		}},
		ComponentNames: map[string]string{"m1": "Weather Fetcher", "s1": "Code Reviewer"},
		Options:        map[string]any{},
	}
}

func TestGenerateKiroShape(t *testing.T) {
	cfg, err := Generate(testRequest("kiro"))
	if err != nil {
		t.Fatal(err)
	}
	blob, _ := json.Marshal(cfg)
	text := string(blob)
	for _, frag := range []string{
		`"path":"~/.kiro/agents/review-bot.json"`,
		`"prompt":"# review-bot - Agent Specialization`,
		`"CARACAL_AGENT_ID":"0656308f-8bba-472e-ab77-f96a7ac69fd2"`,
		`"args":["-m","weather-fetcher"],"command":"python"`,
		`CARACAL_AGENT_ID=0656308f-8bba-472e-ab77-f96a7ac69fd2 caracal hook session-push --harness kiro`,
		`"includeMcpJson":true`,
		`"skill_components"`,
	} {
		if !strings.Contains(text, frag) {
			t.Errorf("kiro config missing %q\n%s", frag, text[:min(len(text), 1200)])
		}
	}
}

func TestGenerateClaudeCodeFrontmatter(t *testing.T) {
	cfg, err := Generate(testRequest("claude-code"))
	if err != nil {
		t.Fatal(err)
	}
	profileAny, _ := cfg.Get("agent_profile")
	profile := profileAny.(map[string]any)
	content := profile["content"].(string)
	for _, frag := range []string{
		"name: review-bot",
		`description: "Automated code review helper"`,
		"mcpServers:\n  - weather-fetcher",
		"hooks:\n  UserPromptSubmit:",
		`command: "caracal hook session-push"`,
		"## MCP Servers\n\n- **Weather Fetcher**",
		"## Skills\n\n- **Code Reviewer**",
	} {
		if !strings.Contains(content, frag) {
			t.Errorf("claude-code content missing %q\n%s", frag, content)
		}
	}
	if !strings.HasPrefix(content, "---\n") {
		t.Error("frontmatter must lead")
	}
}

func TestGenerateUnknownHarness(t *testing.T) {
	if _, err := Generate(testRequest("nope")); err == nil {
		t.Fatal("expected error for unknown harness")
	}
}

func TestResolveModelWarnings(t *testing.T) {
	model, warnings := ResolveModel("kiro", "claude-sonnet-4-5", nil, "not-a-model")
	if model != "" || len(warnings) != 1 || !strings.Contains(warnings[0], "not in the kiro harness registry") {
		t.Fatalf("model=%q warnings=%v", model, warnings)
	}
}

func TestLocalRegistryNamesQualifyDuplicates(t *testing.T) {
	listings := map[string]Listing{
		"a": {"slug": "tool", "namespace": "acme"},
		"b": {"slug": "tool", "namespace": "other.org"},
	}
	names := localRegistryNames([]string{"a", "b"}, listings)
	if names["a"] != "acme-tool" || names["b"] != "other-org-tool" {
		t.Fatalf("names = %v", names)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
