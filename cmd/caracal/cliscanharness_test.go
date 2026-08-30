// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// scanEnvelope mirrors the discovery document `caracal scan -o json` emits.
type scanEnvelope struct {
	Harnesses []map[string]any `json:"harnesses"`
	Mcps      []map[string]any `json:"mcps"`
	Skills    []map[string]any `json:"skills"`
	Hooks     []map[string]any `json:"hooks"`
	Agents    []map[string]any `json:"agents"`
}

// scanHarnessJSON runs a single-harness scan against an isolated HOME.
func scanHarnessJSON(t *testing.T, home, harness string) scanEnvelope {
	t.Helper()
	t.Setenv("HOME", home)
	out, err := captureCLI(t, "scan", "-i", harness, "-o", "json")
	if err != nil {
		t.Fatalf("scan -i %s: %v", harness, err)
	}
	var doc scanEnvelope
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("scan output is not JSON:\n%s", out)
	}
	return doc
}

// rowsHaveField reports whether any row carries field==value.
func rowsHaveField(rows []map[string]any, field, value string) bool {
	for _, row := range rows {
		if s, ok := row[field].(string); ok && s == value {
			return true
		}
	}
	return false
}

func TestScanDiscoversCodexTOMLMcps(t *testing.T) {
	home := t.TempDir()
	seedFile(t, filepath.Join(home, ".codex", "config.toml"),
		"[mcp.servers.weather]\ncommand = \"python\"\nargs = [\"-m\", \"weather\"]\n")
	doc := scanHarnessJSON(t, home, "codex")
	if !rowsHaveField(doc.Mcps, "name", "weather") || !rowsHaveField(doc.Mcps, "source", "codex:global") {
		t.Errorf("codex mcp not discovered: %+v", doc.Mcps)
	}
}

func TestScanDiscoversCopilotVSCodeMcps(t *testing.T) {
	home := t.TempDir()
	seedFile(t, filepath.Join(home, ".vscode", "mcp.json"),
		`{"servers": {"gh": {"url": "https://mcp.example/sse"}}}`)
	doc := scanHarnessJSON(t, home, "copilot")
	if !rowsHaveField(doc.Mcps, "name", "gh") || !rowsHaveField(doc.Mcps, "source", "copilot:global") {
		t.Errorf("copilot vscode mcp not discovered: %+v", doc.Mcps)
	}
	if !rowsHaveField(doc.Mcps, "url", "https://mcp.example/sse") {
		t.Errorf("copilot mcp url missing: %+v", doc.Mcps)
	}
}

func TestScanDiscoversCopilotCliMcpSkillAndHook(t *testing.T) {
	home := t.TempDir()
	seedFile(t, filepath.Join(home, ".copilot", "mcp-config.json"),
		`{"mcpServers": {"mailer": {"command": "node", "args": ["m.js"]}}}`)
	seedFile(t, filepath.Join(home, ".copilot", "skills", "reviewer", "SKILL.md"),
		"---\ndescription: reviews code\n---\nReview things.")
	seedFile(t, filepath.Join(home, ".copilot", "hooks", "telemetry.json"),
		`{"hooks": {"Stop": [{"command": "echo hi"}]}}`)
	doc := scanHarnessJSON(t, home, "copilot-cli")
	if !rowsHaveField(doc.Mcps, "name", "mailer") || !rowsHaveField(doc.Mcps, "source", "copilot-cli:global") {
		t.Errorf("copilot-cli mcp not discovered: %+v", doc.Mcps)
	}
	if !rowsHaveField(doc.Skills, "name", "reviewer") {
		t.Errorf("copilot-cli skill not discovered: %+v", doc.Skills)
	}
	if !rowsHaveField(doc.Hooks, "name", "telemetry/Stop") || !rowsHaveField(doc.Hooks, "source", "copilot-cli:hooks") {
		t.Errorf("copilot-cli hook not discovered: %+v", doc.Hooks)
	}
}

func TestScanDiscoversOpenCodeMcps(t *testing.T) {
	home := t.TempDir()
	seedFile(t, filepath.Join(home, ".config", "opencode", "opencode.json"),
		`{"mcp": {"weather": {"command": ["python", "-m", "weather"]}}}`)
	doc := scanHarnessJSON(t, home, "opencode")
	if !rowsHaveField(doc.Mcps, "name", "weather") || !rowsHaveField(doc.Mcps, "source", "opencode:global") {
		t.Errorf("opencode mcp not discovered: %+v", doc.Mcps)
	}
	if !rowsHaveField(doc.Mcps, "command", "python") {
		t.Errorf("opencode command array head must become the command: %+v", doc.Mcps)
	}
}

func TestScanDiscoversGooseExtensionMcps(t *testing.T) {
	home := t.TempDir()
	seedFile(t, filepath.Join(home, ".config", "goose", "config.yaml"),
		"extensions:\n  weather:\n    type: stdio\n    cmd: python\n    args:\n      - -m\n      - weather\n")
	seedFile(t, filepath.Join(home, ".agents", "skills", "reviewer", "SKILL.md"),
		"---\ndescription: reviews code\n---\nReview.")
	doc := scanHarnessJSON(t, home, "goose")
	if !rowsHaveField(doc.Mcps, "name", "weather") || !rowsHaveField(doc.Mcps, "source", "goose:global") {
		t.Errorf("goose extension mcp not discovered: %+v", doc.Mcps)
	}
	if !rowsHaveField(doc.Skills, "name", "reviewer") || !rowsHaveField(doc.Skills, "source", "goose:skills") {
		t.Errorf("goose skill not discovered: %+v", doc.Skills)
	}
}

func TestScanDiscoversAntigravityMcpHookAndAgent(t *testing.T) {
	home := t.TempDir()
	seedFile(t, filepath.Join(home, ".gemini", "config", "mcp_config.json"),
		`{"mcpServers": {"weather": {"command": "python", "args": ["-m", "w"]}}}`)
	seedFile(t, filepath.Join(home, ".gemini", "config", "hooks.json"),
		`{"caracal-telemetry": {"Stop": [{"command": "echo hi"}]}}`)
	seedFile(t, filepath.Join(home, ".gemini", "config", "agents", "reviewer", "agent.json"),
		`{"name": "reviewer", "description": "reviews code", "model": "gemini-2"}`)
	doc := scanHarnessJSON(t, home, "antigravity")
	if !rowsHaveField(doc.Mcps, "name", "weather") || !rowsHaveField(doc.Mcps, "source", "antigravity:global") {
		t.Errorf("antigravity mcp not discovered: %+v", doc.Mcps)
	}
	if !rowsHaveField(doc.Hooks, "source", "antigravity:hooks") {
		t.Errorf("antigravity hook not discovered: %+v", doc.Hooks)
	}
	if !rowsHaveField(doc.Agents, "name", "reviewer") || !rowsHaveField(doc.Agents, "model_name", "gemini-2") {
		t.Errorf("antigravity agent not discovered: %+v", doc.Agents)
	}
}

func TestScanDiscoversPiMcpAndSkill(t *testing.T) {
	home := t.TempDir()
	seedFile(t, filepath.Join(home, ".pi", "agent", "mcp.json"),
		`{"mcpServers": {"weather": {"command": "python"}}}`)
	seedFile(t, filepath.Join(home, ".pi", "agent", "skills", "reviewer", "SKILL.md"),
		"---\ndescription: reviews code\n---\nReview.")
	doc := scanHarnessJSON(t, home, "pi")
	if !rowsHaveField(doc.Mcps, "name", "weather") || !rowsHaveField(doc.Mcps, "source", "pi:global") {
		t.Errorf("pi mcp not discovered: %+v", doc.Mcps)
	}
	if !rowsHaveField(doc.Skills, "name", "reviewer") {
		t.Errorf("pi skill not discovered: %+v", doc.Skills)
	}
}

func TestScanDiscoversClaudePluginSkillAndAgent(t *testing.T) {
	home := t.TempDir()
	pluginDir := filepath.Join(home, ".claude", "plugins", "acme")
	seedFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"enabledPlugins":{"acme@1.0.0":true,"disabled@1.0.0":false}}`)
	seedFile(t, filepath.Join(home, ".claude", "plugins", "installed_plugins.json"),
		`{"plugins":{"acme@1.0.0":[{"installPath":`+quoteJSON(pluginDir)+`}]}}`)
	seedFile(t, filepath.Join(pluginDir, ".claude-plugin", "plugin.json"),
		`{"description":"Acme Claude plugin"}`)
	seedFile(t, filepath.Join(pluginDir, ".mcp.json"),
		`{"mcpServers":{"weather":{"command":"python"}}}`)
	seedFile(t, filepath.Join(pluginDir, "skills", "reviewer", "SKILL.md"),
		"---\ndescription: plugin review\n---\nReview.")
	seedFile(t, filepath.Join(home, ".claude", "skills", "local", "SKILL.md"),
		"Local skill description.")
	seedFile(t, filepath.Join(home, ".claude", "agents", "helper.md"),
		"---\nmodel: claude-sonnet\n---\nHelp with code.")

	doc := scanHarnessJSON(t, home, "claude-code")
	if !rowsHaveField(doc.Mcps, "name", "weather") || !rowsHaveField(doc.Mcps, "source", "plugin:acme") {
		t.Errorf("claude plugin mcp not discovered: %+v", doc.Mcps)
	}
	if !rowsHaveField(doc.Skills, "name", "acme/reviewer") || !rowsHaveField(doc.Skills, "name", "local") {
		t.Errorf("claude skills not discovered: %+v", doc.Skills)
	}
	if !rowsHaveField(doc.Agents, "name", "helper") || !rowsHaveField(doc.Agents, "model_name", "claude-sonnet") {
		t.Errorf("claude agent not discovered: %+v", doc.Agents)
	}
}

func TestScanDiscoversKiroAgentMcpHookAndSkill(t *testing.T) {
	home := t.TempDir()
	seedFile(t, filepath.Join(home, ".kiro", "settings", "mcp.json"),
		`{"mcpServers":{"weather":{"command":"python"}}}`)
	seedFile(t, filepath.Join(home, ".kiro", "agents", "kiro_default.json"),
		`{"name":"ignored"}`)
	seedFile(t, filepath.Join(home, ".kiro", "agents", "reviewer.json"),
		`{"name":"reviewer","description":"reviews code","model":"kiro-model","prompt":"Check it","mcpServers":{"agentmail":{"command":"node"}},"hooks":{"Stop":[{"command":"echo done"}]}}`)
	seedFile(t, filepath.Join(home, ".kiro", "skills", "auditor", "SKILL.md"),
		"---\ndescription: audits code\n---\nAudit.")

	doc := scanHarnessJSON(t, home, "kiro")
	if !rowsHaveField(doc.Mcps, "name", "weather") || !rowsHaveField(doc.Mcps, "name", "agentmail") {
		t.Errorf("kiro mcps not discovered: %+v", doc.Mcps)
	}
	if !rowsHaveField(doc.Hooks, "name", "kiro:reviewer/Stop") || !rowsHaveField(doc.Hooks, "source", "kiro:agent:reviewer") {
		t.Errorf("kiro hook not discovered: %+v", doc.Hooks)
	}
	if !rowsHaveField(doc.Skills, "name", "auditor") {
		t.Errorf("kiro skill not discovered: %+v", doc.Skills)
	}
	if !rowsHaveField(doc.Agents, "name", "reviewer") || rowsHaveField(doc.Agents, "name", "ignored") {
		t.Errorf("kiro agents wrong: %+v", doc.Agents)
	}
}

func TestScanDiscoversCursorMcps(t *testing.T) {
	home := t.TempDir()
	seedFile(t, filepath.Join(home, ".cursor", "mcp.json"),
		`{"mcpServers":{"docs":{"url":"https://mcp.example/docs"}}}`)
	doc := scanHarnessJSON(t, home, "cursor")
	if !rowsHaveField(doc.Mcps, "name", "docs") || !rowsHaveField(doc.Mcps, "source", "cursor:global") {
		t.Errorf("cursor mcp not discovered: %+v", doc.Mcps)
	}
	if !rowsHaveField(doc.Mcps, "url", "https://mcp.example/docs") {
		t.Errorf("cursor mcp url missing: %+v", doc.Mcps)
	}
}

func quoteJSON(s string) string {
	data, _ := json.Marshal(s)
	return string(data)
}
