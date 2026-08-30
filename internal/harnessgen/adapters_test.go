// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"encoding/json"
	"strings"
	"testing"
)

// generateJSON runs one harness generation and returns the compact JSON view
// the assertions probe, failing the test on any generation error.
func generateJSON(t *testing.T, harness string) string {
	t.Helper()
	cfg, err := Generate(testRequest(harness))
	if err != nil {
		t.Fatalf("Generate(%s): %v", harness, err)
	}
	blob, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal %s config: %v", harness, err)
	}
	return string(blob)
}

func assertFragments(t *testing.T, harness, text string, fragments []string) {
	t.Helper()
	for _, frag := range fragments {
		if !strings.Contains(text, frag) {
			t.Errorf("%s config missing %q", harness, frag)
		}
	}
}

func TestGenerateCursorShape(t *testing.T) {
	text := generateJSON(t, "cursor")
	assertFragments(t, "cursor", text, []string{
		`"path":".cursor/mcp.json"`,
		`"path":".cursor/agents/review-bot.md"`,
		`"path":".cursor/hooks.json"`,
		"\\nmodel: inherit\\n",
		`"beforeSubmitPrompt":[{"command":"caracal hook session-push --harness cursor"`,
		`"stop":[{"command":"caracal hook session-push --harness cursor"`,
		`"merge":true`,
		`"scope":"project"`,
	})
}

func TestGeneratePiShape(t *testing.T) {
	text := generateJSON(t, "pi")
	assertFragments(t, "pi", text, []string{
		`"path":"~/.pi/agent/agents/review-bot/AGENTS.md"`,
		`"path":"~/.pi/agent/agents/review-bot/mcp.json"`,
		// Skills install under the agent's own directory.
		`"path":"~/.pi/agent/agents/review-bot/skills/code-reviewer/SKILL.md"`,
	})
	// Pi agent instructions are plain markdown, never frontmatter-framed.
	cfg, _ := Generate(testRequest("pi"))
	profile, _ := cfg.Get("agent_profile")
	content := profile.(map[string]any)["content"].(string)
	if strings.HasPrefix(content, "---\n") {
		t.Error("pi AGENTS.md must not carry frontmatter")
	}
}

func TestGenerateCodexShape(t *testing.T) {
	text := generateJSON(t, "codex")
	assertFragments(t, "codex", text, []string{
		`"path":".codex/agents/review-bot.toml"`,
		`"path":".codex/config.toml"`,
		`"path":".codex/hooks.json"`,
		// The MCP table uses codex's snake_case key.
		`"mcp_servers":{"weather-fetcher"`,
		// Hook commands carry the agent name for session attribution.
		`CARACAL_AGENT_NAME=review-bot caracal hook session-push --harness codex`,
	})
	// The agent profile is TOML, not JSON or YAML.
	cfg, _ := Generate(testRequest("codex"))
	profile, _ := cfg.Get("agent_profile")
	content := profile.(map[string]any)["content"].(string)
	if !strings.Contains(content, `name = "review-bot"`) {
		t.Errorf("codex profile is not TOML:\n%s", content)
	}
}

func TestGenerateCopilotShape(t *testing.T) {
	text := generateJSON(t, "copilot")
	assertFragments(t, "copilot", text, []string{
		`"path":".github/agents/review-bot.agent.md"`,
		// VS Code MCP config lives in .vscode and uses the "servers" key.
		`"path":".vscode/mcp.json"`,
		`"servers":{"weather-fetcher"`,
		`"type":"stdio"`,
		`target: vscode`,
		`tools: ['*']`,
	})
}

func TestGenerateCopilotCliShape(t *testing.T) {
	text := generateJSON(t, "copilot-cli")
	assertFragments(t, "copilot-cli", text, []string{
		`"path":".github/agents/review-bot.agent.md"`,
		`"path":"~/.copilot/mcp-config.json"`,
		`"path":".github/hooks/caracal.json"`,
		// The agent file inlines its MCP servers in frontmatter.
		"mcp-servers:\\n  weather-fetcher:\\n    type: stdio",
		// Hooks ship both shells with a bounded timeout.
		`"bash":"caracal hook session-push --harness copilot-cli"`,
		`"powershell":"caracal hook session-push --harness copilot-cli"`,
		`"timeoutSec":5`,
		// Skills are emitted as files, not component references.
		`"path":".agents/skills/code-reviewer/SKILL.md"`,
		`"skill_components":[]`,
	})
	for _, event := range []string{"sessionStart", "sessionEnd", "userPromptSubmitted", "preToolUse", "postToolUse"} {
		if !strings.Contains(text, `"`+event+`":[`) {
			t.Errorf("copilot-cli hooks missing event group %q", event)
		}
	}
}

func TestGenerateOpencodeShape(t *testing.T) {
	text := generateJSON(t, "opencode")
	assertFragments(t, "opencode", text, []string{
		`"path":"~/.config/opencode/opencode.json"`,
		`"path":"~/.config/opencode/agents/review-bot.md"`,
		// Opencode folds command and args into one argv array.
		`"command":["python","-m","weather-fetcher"]`,
		`"type":"local"`,
		// Env goes under opencode's "environment" key.
		`"environment":{"CARACAL_AGENT_ID"`,
		`"scope":"user"`,
	})
}

func TestGenerateAntigravityShape(t *testing.T) {
	text := generateJSON(t, "antigravity")
	assertFragments(t, "antigravity", text, []string{
		`"path":"~/.gemini/antigravity-cli/agents/review-bot/agent.json"`,
		`"path":"~/.gemini/antigravity-cli/mcp_config.json"`,
		`"path":"~/.gemini/antigravity-cli/skills/code-reviewer/SKILL.md"`,
		// The agent profile is structured JSON, not markdown.
		`"system_prompt":"You review code.`,
		`"tools":["*"]`,
	})
}

func TestGenerateGooseShape(t *testing.T) {
	text := generateJSON(t, "goose")
	assertFragments(t, "goose", text, []string{
		`"path":"~/.config/goose/config.yaml"`,
		`"path":"~/.agents/agents/review-bot.md"`,
		`"path":"~/.agents/plugins/caracal/hooks/hooks.json"`,
		// Goose models MCP servers as enabled extensions with a timeout.
		`"extensions":{"weather-fetcher"`,
		`"cmd":"python"`,
		`"enabled":true`,
		`"timeout":300`,
		// The managed hook group installs alongside a plugin manifest.
		`"path":"~/.agents/plugins/caracal/plugin.json"`,
		`"merge":true`,
	})
}

// allHarnesses is the full registry surface the generator must serve.
var allHarnesses = []string{
	"claude-code", "kiro", "cursor", "pi", "codex",
	"copilot", "copilot-cli", "opencode", "antigravity", "goose",
}

func TestEveryHarnessGenerates(t *testing.T) {
	for _, h := range allHarnesses {
		if _, err := Generate(testRequest(h)); err != nil {
			t.Errorf("Generate(%s): %v", h, err)
		}
	}
}

// Telemetry flows through session-push hooks only; generating OTEL wiring
// into user configs is an explicit repo policy violation.
func TestNoTelemetryEnvVarsEverGenerated(t *testing.T) {
	for _, h := range allHarnesses {
		text := generateJSON(t, h)
		for _, banned := range []string{"OTEL_", "CLAUDE_CODE_ENABLE_TELEMETRY"} {
			if strings.Contains(text, banned) {
				t.Errorf("%s config contains banned telemetry var %q", h, banned)
			}
		}
	}
}

// Every generated MCP entry must carry the agent ID so sessions attribute
// back to the agent that spawned them.
func TestEveryMcpEntryCarriesAgentID(t *testing.T) {
	for _, h := range allHarnesses {
		text := generateJSON(t, h)
		if !strings.Contains(text, `"CARACAL_AGENT_ID":"0656308f-8bba-472e-ab77-f96a7ac69fd2"`) {
			t.Errorf("%s MCP entry lost the agent ID", h)
		}
	}
}

// Hook commands must target their own harness; a copy-paste slip here sends
// telemetry to the wrong parser. Some harnesses (claude-code) omit the flag
// and rely on parser inference, so the invariant is "never a different one".
func TestHookCommandsNeverTargetAnotherHarness(t *testing.T) {
	for _, h := range allHarnesses {
		text := generateJSON(t, h)
		rest := text
		for {
			_, after, found := strings.Cut(rest, "--harness ")
			if !found {
				break
			}
			target := after
			if i := strings.IndexAny(target, " \"'\\"); i >= 0 {
				target = target[:i]
			}
			if target != h {
				t.Errorf("%s hook command targets %q", h, target)
			}
			rest = after
		}
	}
}
