// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"encoding/json"
	"strings"
	"testing"
)

func jsonEq(t *testing.T, got any, want string) {
	t.Helper()
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var g, w any
	if err := json.Unmarshal(gotJSON, &g); err != nil {
		t.Fatalf("unmarshal got: %v", err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("unmarshal want: %v", err)
	}
	gs, _ := json.Marshal(g)
	ws, _ := json.Marshal(w)
	if string(gs) != string(ws) {
		t.Fatalf("mismatch:\n got %s\nwant %s", gs, ws)
	}
}

func TestHookInstallSnippet(t *testing.T) {
	cases := []struct {
		harness string
		want    string
	}{
		{"claude-code", `{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"python guard.py","timeout":10}]}]}}`},
		{"cursor", `{"version":1,"hooks":{"PreToolUse":[{"command":"python guard.py"}]}}`},
		{"kiro", `{"hooks":{"PreToolUse":[{"command":"python guard.py"}]}}`},
		{"copilot", `{"hooks":{"PreToolUse":[{"command":"python guard.py"}]}}`},
		{"copilot-cli", `{"hooks":{"PreToolUse":[{"command":"python guard.py"}]}}`},
		{"codex", `{"hooks":{"PreToolUse":{"command":"python guard.py"}},"_format":"toml","_note":"Add to .codex/config.toml under [hooks.PreToolUse]"}`},
		{"goose", `{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"python guard.py","timeout":10}]}]},"_note":"Add to .agents/plugins/caracal/hooks/hooks.json"}`},
		{"antigravity", `{"hooks":{"PreToolUse":[{"command":"python guard.py","timeout":10}]}}`},
	}
	for _, tc := range cases {
		t.Run(tc.harness, func(t *testing.T) {
			jsonEq(t, HookInstallSnippet(tc.harness, "PreToolUse", "command", "python guard.py", 10), tc.want)
		})
	}
	t.Run("no timeout omitted", func(t *testing.T) {
		jsonEq(t, HookInstallSnippet("claude-code", "Stop", "command", "x", 0),
			`{"hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"x"}]}]}}`)
	})
}

func TestMcpInstallSnippet(t *testing.T) {
	stdio := McpSnippetInput{
		Slug: "fs-mcp", Command: "uvx", HasCommand: true, Args: []string{"fs-server"},
		EnvVarNames: []string{"FS_ROOT"}, EnvValues: map[string]string{"FS_ROOT": "/data"},
	}
	remote := McpSnippetInput{Slug: "api-mcp", URL: "https://mcp.example.com/sse", Transport: "sse",
		HeaderValues: map[string]string{"X-Auth": "abc"}}

	t.Run("default harness stdio", func(t *testing.T) {
		got, err := McpInstallSnippet("kiro", stdio)
		if err != nil {
			t.Fatal(err)
		}
		jsonEq(t, got, `{"mcpServers":{"fs-mcp":{"command":"uvx","args":["fs-server"],"env":{"FS_ROOT":"/data"}}}}`)
	})
	t.Run("claude stdio is shell command", func(t *testing.T) {
		got, _ := McpInstallSnippet("claude-code", stdio)
		jsonEq(t, got, `{"command":["claude","mcp","add","fs-mcp","--","uvx","fs-server"],"type":"shell_command"}`)
	})
	t.Run("claude remote keeps settings snippet", func(t *testing.T) {
		got, _ := McpInstallSnippet("claude-code", remote)
		jsonEq(t, got, `{"command":["claude","mcp","add","api-mcp","--url","https://mcp.example.com/sse"],
			"type":"shell_command","claude_settings_snippet":{},
			"mcpServers":{"api-mcp":{"type":"sse","url":"https://mcp.example.com/sse","headers":{"X-Auth":"abc"}}}}`)
	})
	t.Run("codex remote", func(t *testing.T) {
		got, _ := McpInstallSnippet("codex", remote)
		jsonEq(t, got, `{"mcp_servers":{"api-mcp":{"url":"https://mcp.example.com/sse","headers":{"X-Auth":"abc"}}}}`)
	})
	t.Run("copilot-cli adds stdio type and tools", func(t *testing.T) {
		got, _ := McpInstallSnippet("copilot-cli", stdio)
		jsonEq(t, got, `{"mcpServers":{"fs-mcp":{"type":"stdio","command":"uvx","args":["fs-server"],"env":{"FS_ROOT":"/data"},"tools":["*"]}}}`)
	})
	t.Run("goose extension entry", func(t *testing.T) {
		got, _ := McpInstallSnippet("goose", stdio)
		jsonEq(t, got, `{"extensions":{"fs-mcp":{"type":"stdio","name":"fs-mcp","enabled":true,"cmd":"uvx","args":["fs-server"],"envs":{"FS_ROOT":"/data"},"env_keys":[],"timeout":300}}}`)
	})
	t.Run("opencode local entry", func(t *testing.T) {
		got, _ := McpInstallSnippet("opencode", stdio)
		jsonEq(t, got, `{"mcp":{"fs-mcp":{"type":"local","command":["uvx","fs-server"],"environment":{"FS_ROOT":"/data"}}}}`)
	})
	t.Run("unknown harness errors", func(t *testing.T) {
		if _, err := McpInstallSnippet("vscode", stdio); err == nil {
			t.Fatal("want error for unknown harness")
		}
	})
	t.Run("sanitizes local name", func(t *testing.T) {
		in := stdio
		in.LocalName = "My Fancy MCP!"
		got, _ := McpInstallSnippet("kiro", in)
		if _, ok := got["mcpServers"].(map[string]any)["My-Fancy-MCP-"]; !ok {
			t.Fatalf("sanitized name missing: %v", got)
		}
	})
}

func TestSkillInstallFile(t *testing.T) {
	file := SkillInstallFile("claude-code", "project", "reviewer", "Reviews code.", "Reviews code.\n\nLong body.", "review")
	if file == nil {
		t.Fatal("nil file")
	}
	if file["path"] != ".claude/skills/reviewer/SKILL.md" {
		t.Fatalf("path %v", file["path"])
	}
	content := file["content"].(string)
	for _, want := range []string{"name: reviewer", "description: Reviews code.", "command: /review", "Long body."} {
		if !strings.Contains(content, want) {
			t.Fatalf("content missing %q:\n%s", want, content)
		}
	}
}
