// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/harness"
)

// richRequest extends testRequest with hook and prompt components
// so adapters exercise their component-emission branches.
func richRequest(harnessName string) *Request {
	req := testRequest(harnessName)
	req.Agent.Components = append(req.Agent.Components,
		ComponentLink{Type: "hook", ID: "h1", OrderIndex: 2},
		ComponentLink{Type: "prompt", ID: "p1", OrderIndex: 3},
	)
	req.Agent.RequiredCapabilities = []any{"skills", "hooks", "mcp_servers"}
	req.HookListings = map[string]Listing{"h1": {
		"slug": "guard-hook", "namespace": "acme", "status": "approved",
		"event": "PreToolUse", "handler_type": "command",
		"handler_config":  map[string]any{"command": "guard.sh", "matcher": "Bash"},
		"script_filename": "guard.sh", "script_content": "#!/bin/sh\necho hi\n",
	}}
	req.PromptListings = map[string]Listing{"p1": {
		"slug": "review-prompt", "namespace": "acme", "status": "approved",
		"template": "Please review carefully.",
	}}
	req.ComponentNames["h1"] = "Guard Hook"
	req.ComponentNames["p1"] = "Review Prompt"
	return req
}

// TestGenerateRichComponents drives every adapter with a full component set,
// covering rules assembly and hook config extraction.
func TestGenerateRichComponents(t *testing.T) {
	for _, name := range HarnessNames() {
		t.Run(name, func(t *testing.T) {
			cfg, err := Generate(richRequest(name))
			if err != nil {
				t.Fatalf("Generate(%s): %v", name, err)
			}
			if _, err := json.Marshal(cfg); err != nil {
				t.Fatalf("marshal %s: %v", name, err)
			}
		})
	}
}

func TestGenerateClaudeCodeCustomHooks(t *testing.T) {
	cfg, err := Generate(richRequest("claude-code"))
	if err != nil {
		t.Fatal(err)
	}
	profile, _ := cfg.Get("agent_profile")
	content := profile.(map[string]any)["content"].(string)
	// The command hook whose command equals its script filename is rewritten
	// under the managed hooks directory.
	if !strings.Contains(content, ".claude/hooks/guard.sh") {
		t.Errorf("claude-code custom command hook not rewritten:\n%s", content)
	}
	// Hook script files are emitted as executable install artifacts.
	files, ok := cfg.Get("hook_files")
	if !ok {
		t.Fatal("claude-code hook_files missing")
	}
	blob, _ := json.Marshal(files)
	if !strings.Contains(string(blob), `"executable":true`) {
		t.Errorf("hook file not marked executable: %s", blob)
	}
}

func TestGenerateOpencodeHookPlugins(t *testing.T) {
	cfg, err := Generate(richRequest("opencode"))
	if err != nil {
		t.Fatal(err)
	}
	files, ok := cfg.Get("hook_files")
	if !ok {
		t.Fatal("opencode hook_files missing")
	}
	blob, _ := json.Marshal(files)
	text := string(blob)
	if !strings.Contains(text, ".opencode/plugins/hook-guard-hook.ts") {
		t.Errorf("opencode hook plugin path missing:\n%s", text)
	}
	if !strings.Contains(text, "Hook_guard_hook") {
		t.Errorf("opencode plugin export not generated:\n%s", text)
	}
}

func TestGenerateCodexCustomHooks(t *testing.T) {
	cfg, err := Generate(richRequest("codex"))
	if err != nil {
		t.Fatal(err)
	}
	hooksConfig, ok := cfg.Get("hooks_config")
	if !ok {
		t.Fatal("codex hooks_config missing")
	}
	blob, _ := json.Marshal(hooksConfig)
	text := string(blob)
	// The attached command hook lands as a matcher-group under PreToolUse,
	// alongside the telemetry groups, pointing at the managed scripts dir.
	if !strings.Contains(text, "PreToolUse") || !strings.Contains(text, ".codex/hooks/guard.sh") {
		t.Errorf("codex custom hook not materialized:\n%s", text)
	}
	if !strings.Contains(text, `"matcher":"Bash"`) {
		t.Errorf("codex hook matcher not preserved:\n%s", text)
	}
	files, ok := cfg.Get("hook_files")
	if !ok {
		t.Fatal("codex hook_files missing")
	}
	fblob, _ := json.Marshal(files)
	if !strings.Contains(string(fblob), `"executable":true`) {
		t.Errorf("codex hook file not executable: %s", fblob)
	}
}

func TestGenerateCopilotCustomHooks(t *testing.T) {
	cfg, err := Generate(richRequest("copilot"))
	if err != nil {
		t.Fatal(err)
	}
	hooksConfig, ok := cfg.Get("hooks_config")
	if !ok {
		t.Fatal("copilot hooks_config missing")
	}
	entry := hooksConfig.(map[string]any)
	path, _ := entry["path"].(string)
	if !strings.HasPrefix(path, ".github/hooks/") || !strings.HasSuffix(path, ".json") {
		t.Errorf("copilot hooks path = %q", path)
	}
	blob, _ := json.Marshal(entry["content"])
	text := string(blob)
	// VS Code Copilot requires type:command and reads the PascalCase event.
	if !strings.Contains(text, "PreToolUse") || !strings.Contains(text, `"type":"command"`) {
		t.Errorf("copilot hook not in VS Code format:\n%s", text)
	}
	if !strings.Contains(text, ".github/hooks/scripts/guard.sh") {
		t.Errorf("copilot hook command not pointed at scripts dir:\n%s", text)
	}
}

func TestGenerateHTTPHookCurlWrap(t *testing.T) {
	req := richRequest("cursor")
	req.HookListings["h1"] = Listing{
		"slug": "webhook", "namespace": "acme", "status": "approved",
		"event": "PreToolUse", "handler_type": "http",
		"handler_config": map[string]any{"url": "https://hooks.example/x"},
	}
	cfg, err := Generate(req)
	if err != nil {
		t.Fatal(err)
	}
	hooksConfig, _ := cfg.Get("hooks_config")
	blob, _ := json.Marshal(hooksConfig)
	// Cursor has no native HTTP hook type, so the URL is delivered via curl.
	if !strings.Contains(string(blob), "curl -s -X POST") || !strings.Contains(string(blob), "https://hooks.example/x") {
		t.Errorf("http hook not wrapped as curl:\n%s", blob)
	}
}

func TestCustomHookMatcherLines(t *testing.T) {
	t.Run("command rewritten to managed dir", func(t *testing.T) {
		h := hookConfig{
			"handler_type":    "command",
			"handler_config":  map[string]any{"command": "guard.sh"},
			"script_filename": "guard.sh",
		}
		lines := customHookMatcherLines(h)
		joined := strings.Join(lines, "\n")
		if !strings.Contains(joined, ".claude/hooks/guard.sh") {
			t.Errorf("lines = %q", joined)
		}
	})
	t.Run("http hook", func(t *testing.T) {
		h := hookConfig{
			"handler_type":   "http",
			"handler_config": map[string]any{"url": "https://hooks.example/x", "timeout": 15},
		}
		lines := customHookMatcherLines(h)
		joined := strings.Join(lines, "\n")
		if !strings.Contains(joined, "type: http") || !strings.Contains(joined, "https://hooks.example/x") {
			t.Errorf("http lines = %q", joined)
		}
		if !strings.Contains(joined, "timeout: 15") {
			t.Errorf("timeout not rendered: %q", joined)
		}
	})
	t.Run("empty command yields no lines", func(t *testing.T) {
		h := hookConfig{"handler_type": "command", "handler_config": map[string]any{}}
		if lines := customHookMatcherLines(h); lines != nil {
			t.Errorf("want nil, got %q", lines)
		}
	})
}

func TestOpencodeHookPluginGenerators(t *testing.T) {
	t.Run("command plugin", func(t *testing.T) {
		src := opencodeCommandHookPlugin("guard-hook", "session.idle", "echo hi")
		if !strings.Contains(src, "Hook_guard_hook") || !strings.Contains(src, `"echo hi"`) {
			t.Errorf("command plugin = %s", src)
		}
		if !strings.Contains(src, `event?.type === "session.idle"`) {
			t.Errorf("event guard missing: %s", src)
		}
	})
	t.Run("https plugin", func(t *testing.T) {
		src := opencodeHTTPHookPlugin("guard", "session.idle", "https://example.com/hook", 10)
		if !strings.Contains(src, `import { request } from "https"`) {
			t.Errorf("https module import missing: %s", src)
		}
		if !strings.Contains(src, "timeout: 10000") {
			t.Errorf("timeout not scaled to ms: %s", src)
		}
	})
	t.Run("http plugin", func(t *testing.T) {
		src := opencodeHTTPHookPlugin("guard", "e", "http://example.com/hook", 5)
		if !strings.Contains(src, `import { request } from "http"`) {
			t.Errorf("http module import missing: %s", src)
		}
	})
	t.Run("invalid url skipped", func(t *testing.T) {
		src := opencodeHTTPHookPlugin("guard", "e", "not-a-url", 5)
		if !strings.Contains(src, "SKIPPED (invalid URL)") {
			t.Errorf("invalid url not skipped: %s", src)
		}
	})
}

func TestFormatModelAdapters(t *testing.T) {
	cases := []struct {
		name    string
		adapter interface {
			formatModel(model, provider string) string
		}
		model    string
		provider string
		want     string
	}{
		{"base identity", base{}, "gpt-4", "openai", "gpt-4"},
		{"codex identity", codexAdapter{}, "gpt-4", "openai", "gpt-4"},
		{"kiro dotted date", kiroAdapter{}, "claude-sonnet-4-5-20250101", "anthropic", "claude-sonnet-4.5-20250101"},
		{"kiro dotted minor", kiroAdapter{}, "claude-sonnet-4-5", "anthropic", "claude-sonnet-4.5"},
		{"kiro non-claude", kiroAdapter{}, "gpt-4", "openai", "gpt-4"},
		{"claude alias", claudeCodeAdapter{}, "claude-3-5-sonnet", "anthropic", "sonnet"},
		{"claude passthrough", claudeCodeAdapter{}, "gpt-4o", "openai", "gpt-4o"},
		{"opencode qualifies", opencodeAdapter{}, "gpt-4", "openai", "openai/gpt-4"},
		{"opencode slashed", opencodeAdapter{}, "anthropic/claude", "anthropic", "anthropic/claude"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.adapter.formatModel(tc.model, tc.provider); got != tc.want {
				t.Errorf("formatModel(%q,%q) = %q want %q", tc.model, tc.provider, got, tc.want)
			}
		})
	}
}

func TestModelFallbackAdapters(t *testing.T) {
	if got := (base{}).defaultModelCandidate("claude-sonnet"); got != "" {
		t.Errorf("base defaultModelCandidate = %q", got)
	}
	if got := (base{}).previewModelFallback("claude-sonnet"); got != "" {
		t.Errorf("base previewModelFallback = %q", got)
	}
	if got := (claudeCodeAdapter{}).defaultModelCandidate("claude-x"); got != "claude-x" {
		t.Errorf("claude defaultModelCandidate = %q", got)
	}
	if got := (claudeCodeAdapter{}).previewModelFallback("claude-sonnet-4"); got != "sonnet" {
		t.Errorf("claude previewModelFallback = %q", got)
	}
}

func TestFormatHookComponentAdapters(t *testing.T) {
	cases := []struct {
		name    string
		adapter interface{ formatHookComponent(command string) any }
		want    string
	}{
		{"base", base{}, `{"command":"run.sh"}`},
		{"copilot", copilotAdapter{}, `{"command":"run.sh","type":"command"}`},
		{"copilot-cli", copilotCliAdapter{}, `{"command":"run.sh","type":"command"}`},
		{"goose", gooseAdapter{}, `{"hooks":[{"command":"run.sh","type":"command"}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			blob, _ := json.Marshal(tc.adapter.formatHookComponent("run.sh"))
			var got, want any
			_ = json.Unmarshal(blob, &got)
			_ = json.Unmarshal([]byte(tc.want), &want)
			g, _ := json.Marshal(got)
			w, _ := json.Marshal(want)
			if string(g) != string(w) {
				t.Errorf("formatHookComponent = %s want %s", g, w)
			}
		})
	}
}

func TestPreviewModel(t *testing.T) {
	if got := PreviewModel("claude-code", "claude-sonnet-4"); got != "sonnet" {
		t.Errorf("claude-code preview = %q", got)
	}
	if got := PreviewModel("kiro", "claude-sonnet-4"); got != "" {
		t.Errorf("kiro preview should be empty (base), got %q", got)
	}
	if got := PreviewModel("nope", "x"); got != "" {
		t.Errorf("unknown harness preview = %q", got)
	}
}

func TestResolveModelSuccessPath(t *testing.T) {
	// Find a harness whose formatModel is identity and that publishes models,
	// so an override equal to a supported id resolves cleanly.
	for _, name := range HarnessNames() {
		supported, err := harness.SupportedModelIDs(name)
		if err != nil || len(supported) == 0 {
			continue
		}
		adapter := adapters[name]
		id := supported[0]
		if adapter.formatModel(id, "anthropic") != id {
			continue
		}
		model, warnings := ResolveModel(name, "", nil, id)
		if model != id {
			t.Fatalf("%s ResolveModel(override=%q) = %q, warnings=%v", name, id, model, warnings)
		}
		for _, w := range warnings {
			if strings.Contains(w, "not in the") {
				t.Fatalf("%s unexpected registry warning: %v", name, warnings)
			}
		}
		// Also cover the modelsByHarness path with the same supported id.
		model2, _ := ResolveModel(name, "", map[string]any{name: id}, "")
		if model2 != id {
			t.Fatalf("%s ResolveModel(modelsByHarness) = %q", name, model2)
		}
		return
	}
	t.Skip("no identity-formatModel harness with published models")
}
