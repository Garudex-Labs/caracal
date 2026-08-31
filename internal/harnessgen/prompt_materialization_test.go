// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"encoding/json"
	"strings"
	"testing"
)

// promptRequest builds a request carrying one prompt component.
func promptRequest(harnessName string) *Request {
	req := testRequest(harnessName)
	req.Agent.Components = append(req.Agent.Components,
		ComponentLink{Type: "prompt", ID: "p1", OrderIndex: 2})
	req.PromptListings = map[string]Listing{"p1": {
		"name": "Review Prompt", "slug": "review-prompt", "namespace": "acme",
		"status": "approved", "description": "Careful review", "template": "Please review carefully.",
	}}
	req.ComponentNames["p1"] = "Review Prompt"
	return req
}

// nativePromptPaths pins the documented native prompt location per harness.
var nativePromptPaths = map[string]string{
	"claude-code": ".claude/commands/review-prompt.md",
	"copilot":     ".github/prompts/review-prompt.prompt.md",
	"codex":       "~/.codex/prompts/acme-review-prompt.md",
	"cursor":      ".cursor/commands/review-prompt.md",
}

func promptFilesOf(t *testing.T, cfg *Config) []map[string]any {
	t.Helper()
	raw, ok := cfg.Get("prompt_files")
	if !ok {
		return nil
	}
	files, ok := raw.([]map[string]any)
	if !ok {
		t.Fatalf("prompt_files is %T", raw)
	}
	return files
}

func TestPromptNativeMaterialization(t *testing.T) {
	for harnessName, wantPath := range nativePromptPaths {
		t.Run(harnessName, func(t *testing.T) {
			cfg, err := Generate(promptRequest(harnessName))
			if err != nil {
				t.Fatal(err)
			}
			files := promptFilesOf(t, cfg)
			if len(files) != 1 {
				t.Fatalf("want 1 native prompt file, got %d", len(files))
			}
			if got := files[0]["path"]; got != wantPath {
				t.Errorf("path = %v, want %v", got, wantPath)
			}
			content, _ := files[0]["content"].(string)
			if !strings.Contains(content, managedPromptMarker) {
				t.Errorf("native prompt file missing managed marker:\n%s", content)
			}
			if !strings.Contains(content, "Please review carefully.") {
				t.Errorf("native prompt file missing template:\n%s", content)
			}
			if !strings.Contains(content, "acme/review-prompt") {
				t.Errorf("native prompt file missing identity marker:\n%s", content)
			}
			// A native harness must not also inline the template into the body.
			profileAny, _ := cfg.Get("agent_profile")
			if profile, ok := profileAny.(map[string]any); ok {
				if body, ok := profile["content"].(string); ok &&
					strings.Contains(body, "Please review carefully.") {
					t.Errorf("native harness duplicated the template into the agent body")
				}
			}
		})
	}
}

func TestPromptEmbeddedMaterialization(t *testing.T) {
	for _, harnessName := range []string{"copilot-cli", "kiro", "pi", "goose", "opencode", "antigravity"} {
		t.Run(harnessName, func(t *testing.T) {
			cfg, err := Generate(promptRequest(harnessName))
			if err != nil {
				t.Fatal(err)
			}
			if files := promptFilesOf(t, cfg); len(files) != 0 {
				t.Errorf("embedded harness must not emit native prompt files, got %d", len(files))
			}
			blob, _ := json.Marshal(cfg)
			if !strings.Contains(string(blob), "Please review carefully.") {
				t.Errorf("embedded harness dropped the prompt template:\n%s", blob)
			}
		})
	}
}

// TestPromptNoSilentLoss guards the core invariant: every supported harness
// materializes an attached prompt somewhere, never silently dropping it.
func TestPromptNoSilentLoss(t *testing.T) {
	for _, harnessName := range HarnessNames() {
		t.Run(harnessName, func(t *testing.T) {
			cfg, err := Generate(promptRequest(harnessName))
			if err != nil {
				t.Fatal(err)
			}
			for _, f := range promptFilesOf(t, cfg) {
				if content, _ := f["content"].(string); strings.Contains(content, "Please review carefully.") {
					return
				}
			}
			blob, _ := json.Marshal(cfg)
			if !strings.Contains(string(blob), "Please review carefully.") {
				t.Fatalf("%s silently dropped the prompt template", harnessName)
			}
		})
	}
}

// TestKiroEmbedsPrompt is the specific regression: Kiro previously ignored the
// rules content and dropped attached prompt components.
func TestKiroEmbedsPrompt(t *testing.T) {
	cfg, err := Generate(promptRequest("kiro"))
	if err != nil {
		t.Fatal(err)
	}
	text := marshalString(t, cfg)
	if !strings.Contains(text, "## Prompts") || !strings.Contains(text, "Please review carefully.") {
		t.Errorf("kiro must embed the prompt section:\n%s", text[:min(len(text), 1500)])
	}
}

// TestPromptCanonicalNamingCollision verifies two prompts sharing a slug from
// different namespaces receive distinct, safe native filenames.
func TestPromptCanonicalNamingCollision(t *testing.T) {
	req := testRequest("copilot")
	req.Agent.Components = append(req.Agent.Components,
		ComponentLink{Type: "prompt", ID: "p1", OrderIndex: 2},
		ComponentLink{Type: "prompt", ID: "p2", OrderIndex: 3},
	)
	req.PromptListings = map[string]Listing{
		"p1": {"slug": "review", "namespace": "acme", "status": "approved", "template": "A"},
		"p2": {"slug": "review", "namespace": "globex", "status": "approved", "template": "B"},
	}
	cfg, err := Generate(req)
	if err != nil {
		t.Fatal(err)
	}
	files := promptFilesOf(t, cfg)
	if len(files) != 2 {
		t.Fatalf("want 2 prompt files, got %d", len(files))
	}
	paths := map[string]bool{}
	for _, f := range files {
		p, _ := f["path"].(string)
		if paths[p] {
			t.Errorf("colliding prompt file path: %s", p)
		}
		paths[p] = true
	}
	if len(paths) != 2 {
		t.Errorf("expected 2 distinct paths, got %v", paths)
	}
}

func marshalString(t *testing.T, cfg *Config) string {
	t.Helper()
	blob, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(blob)
}

// promptReqNS builds a request with one prompt component of a given identity.
func promptReqNS(harnessName, ns, slug string) *Request {
	req := testRequest(harnessName)
	req.Agent.Components = append(req.Agent.Components,
		ComponentLink{Type: "prompt", ID: "p1", OrderIndex: 2})
	req.PromptListings = map[string]Listing{"p1": {
		"namespace": ns, "slug": slug, "status": "approved", "template": "T",
	}}
	return req
}

func firstPromptPath(t *testing.T, cfg *Config) string {
	t.Helper()
	files := promptFilesOf(t, cfg)
	if len(files) != 1 {
		t.Fatalf("want 1 prompt file, got %d", len(files))
	}
	p, _ := files[0]["path"].(string)
	return p
}

// TestPromptResolutionScopes locks the deterministic resolution: workspace
// harnesses resolve a project-relative path, the user-level-only harness a
// shared home path.
func TestPromptResolutionScopes(t *testing.T) {
	cases := map[string]struct {
		workspace bool
		prefix    string
	}{
		"claude-code": {true, ".claude/commands/"},
		"copilot":     {true, ".github/prompts/"},
		"cursor":      {true, ".cursor/commands/"},
		"codex":       {false, "~/.codex/prompts/"},
	}
	for name, want := range cases {
		spec, ok := specOf(name)
		if !ok {
			t.Fatalf("no spec for %s", name)
		}
		res, ok := spec.ResolvePrompt()
		if !ok {
			t.Fatalf("%s has no prompt resolution", name)
		}
		if res.Workspace != want.workspace {
			t.Errorf("%s Workspace = %v, want %v", name, res.Workspace, want.workspace)
		}
		if !strings.HasPrefix(res.Path, want.prefix) {
			t.Errorf("%s path = %s, want prefix %s", name, res.Path, want.prefix)
		}
	}
}

// TestPromptUserLevelCrossProjectNoClobber proves two projects installing
// different prompts into the same shared user-level location get distinct
// files, so one project cannot overwrite another's prompt.
func TestPromptUserLevelCrossProjectNoClobber(t *testing.T) {
	a, err := Generate(promptReqNS("codex", "acme", "review"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := Generate(promptReqNS("codex", "globex", "review"))
	if err != nil {
		t.Fatal(err)
	}
	pa, pb := firstPromptPath(t, a), firstPromptPath(t, b)
	if pa == pb {
		t.Fatalf("shared user-level prompts collided: %s", pa)
	}
	for _, p := range []string{pa, pb} {
		if !strings.HasPrefix(p, "~/.codex/prompts/") {
			t.Errorf("user-level prompt escaped shared dir: %s", p)
		}
	}
	if pa != "~/.codex/prompts/acme-review.md" || pb != "~/.codex/prompts/globex-review.md" {
		t.Errorf("user-level names not namespace-qualified: %s, %s", pa, pb)
	}
}

// TestPromptWorkspaceProjectIsolation proves a workspace-capable harness uses a
// project-relative path with a bare name, keeping per-project state separate by
// directory rather than by filename.
func TestPromptWorkspaceProjectIsolation(t *testing.T) {
	cfg, err := Generate(promptReqNS("claude-code", "acme", "review"))
	if err != nil {
		t.Fatal(err)
	}
	if got := firstPromptPath(t, cfg); got != ".claude/commands/review.md" {
		t.Errorf("workspace path = %s, want .claude/commands/review.md", got)
	}
}

// TestPromptArgumentHintFromVariables verifies declared template variables are
// surfaced as the native argument-hint on frontmatter harnesses, covering both
// bare-name and object variable forms.
func TestPromptArgumentHintFromVariables(t *testing.T) {
	for _, h := range []string{"copilot", "claude-code"} {
		t.Run(h, func(t *testing.T) {
			req := testRequest(h)
			req.Agent.Components = append(req.Agent.Components,
				ComponentLink{Type: "prompt", ID: "p1", OrderIndex: 2})
			req.PromptListings = map[string]Listing{"p1": {
				"slug": "review", "namespace": "acme", "status": "approved",
				"template":  "Review {{code}} in {{language}}.",
				"variables": []any{"code", map[string]any{"name": "language"}},
			}}
			cfg, err := Generate(req)
			if err != nil {
				t.Fatal(err)
			}
			files := promptFilesOf(t, cfg)
			if len(files) != 1 {
				t.Fatalf("want 1 prompt file, got %d", len(files))
			}
			content, _ := files[0]["content"].(string)
			if !strings.Contains(content, `argument-hint: "[code] [language]"`) {
				t.Errorf("missing argument-hint:\n%s", content)
			}
		})
	}
}

// TestPromptNoArgumentHintWithoutVariables confirms the hint is omitted when a
// prompt declares no variables.
func TestPromptNoArgumentHintWithoutVariables(t *testing.T) {
	cfg, err := Generate(promptRequest("copilot"))
	if err != nil {
		t.Fatal(err)
	}
	content, _ := promptFilesOf(t, cfg)[0]["content"].(string)
	if strings.Contains(content, "argument-hint") {
		t.Errorf("unexpected argument-hint for a variable-free prompt:\n%s", content)
	}
}
