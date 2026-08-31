// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"strings"
	"testing"
)

func body(raw map[string]any) *draftBody { return &draftBody{raw: raw} }

// errFields flattens the accumulated errors into "type loc" strings.
func errFields(b *draftBody) []string {
	out := make([]string, 0, len(b.errs))
	for _, e := range b.errs {
		out = append(out, e.Type+" "+strings.Join(e.Loc, "."))
	}
	return out
}

func hasErr(b *draftBody, kind, lastLoc string) bool {
	for _, e := range b.errs {
		if e.Type == kind && e.Loc[len(e.Loc)-1] == lastLoc {
			return true
		}
	}
	return false
}

func validMCPBody() map[string]any {
	return map[string]any{
		"name": "acme", "version": "1.0.0", "description": "an mcp",
		"category": "developer-tools", "owner": "acme-team", "command": "npx",
	}
}

func TestValidateSubmitAcceptsValidMCP(t *testing.T) {
	b := body(validMCPBody())
	name, version, description, owner := validateSubmit(Families["mcps"], b)
	if len(b.errs) != 0 {
		t.Fatalf("unexpected errors: %v", errFields(b))
	}
	if name != "acme" || version != "1.0.0" || description != "an mcp" || owner != "acme-team" {
		t.Errorf("fields = %q %q %q %q", name, version, description, owner)
	}
}

func TestValidateSubmitReportsEveryMissingField(t *testing.T) {
	b := body(map[string]any{})
	validateSubmit(Families["mcps"], b)
	for _, field := range []string{"name", "version", "description", "category", "owner"} {
		if !hasErr(b, "missing", field) {
			t.Errorf("missing-field error for %q not reported: %v", field, errFields(b))
		}
	}
}

func TestValidateSubmitRejectsWrongTypes(t *testing.T) {
	raw := validMCPBody()
	raw["name"] = 42
	b := body(raw)
	validateSubmit(Families["mcps"], b)
	if !hasErr(b, "string_type", "name") {
		t.Errorf("want string_type on name, got %v", errFields(b))
	}
}

func TestValidateSubmitRejectsUnknownOptions(t *testing.T) {
	raw := validMCPBody()
	raw["category"] = "not-a-category"
	raw["framework"] = "cobol"
	b := body(raw)
	validateSubmit(Families["mcps"], b)
	if !hasErr(b, "value_error", "category") || !hasErr(b, "value_error", "framework") {
		t.Errorf("want option errors on category and framework, got %v", errFields(b))
	}
}

func TestValidateSubmitMCPRequiresAnEntrypoint(t *testing.T) {
	raw := validMCPBody()
	delete(raw, "command")
	b := body(raw)
	validateSubmit(Families["mcps"], b)
	if !hasErr(b, "value_error", "body") {
		t.Errorf("want model-level entrypoint error, got %v", errFields(b))
	}
	for _, key := range []string{"git_url", "url"} {
		raw := validMCPBody()
		delete(raw, "command")
		raw[key] = "something"
		b := body(raw)
		validateSubmit(Families["mcps"], b)
		if len(b.errs) != 0 {
			t.Errorf("%s alone should satisfy the entrypoint rule: %v", key, errFields(b))
		}
	}
}

func TestValidateSubmitHookDefaultsAndOptions(t *testing.T) {
	raw := map[string]any{
		"name": "guard", "version": "1.0.0", "description": "a hook", "owner": "acme",
		"event": "PreToolUse", "handler_type": "command",
	}
	b := body(raw)
	validateSubmit(Families["hooks"], b)
	if len(b.errs) != 0 {
		t.Fatalf("defaults for execution_mode/scope should pass: %v", errFields(b))
	}

	raw["execution_mode"] = "eventually"
	raw["scope"] = "galaxy"
	raw["event"] = "OnVibes"
	b = body(raw)
	validateSubmit(Families["hooks"], b)
	for _, field := range []string{"execution_mode", "scope", "event"} {
		if !hasErr(b, "value_error", field) {
			t.Errorf("want option error on %q, got %v", field, errFields(b))
		}
	}
}

func TestValidateSubmitHookHarnessSupport(t *testing.T) {
	base := func() map[string]any {
		return map[string]any{
			"name": "guard", "version": "1.0.0", "description": "a hook", "owner": "acme",
			"event": "PreToolUse", "handler_type": "command",
		}
	}
	// Native and plugin-compatible harnesses are accepted.
	raw := base()
	raw["supported_harnesses"] = []any{"claude-code", "cursor", "codex", "copilot", "opencode"}
	b := body(raw)
	validateSubmit(Families["hooks"], b)
	if len(b.errs) != 0 {
		t.Fatalf("supported harnesses should pass: %v", errFields(b))
	}
	// Telemetry-only / unsupported harnesses are rejected on supported_harnesses.
	for _, unsupported := range []string{"pi", "antigravity"} {
		raw := base()
		raw["supported_harnesses"] = []any{"claude-code", unsupported}
		b := body(raw)
		validateSubmit(Families["hooks"], b)
		if !hasErr(b, "value_error", "supported_harnesses") {
			t.Errorf("%s should be rejected, got %v", unsupported, errFields(b))
		}
	}
	// Unknown harness is rejected too.
	raw = base()
	raw["supported_harnesses"] = []any{"not-a-harness"}
	b = body(raw)
	validateSubmit(Families["hooks"], b)
	if !hasErr(b, "value_error", "supported_harnesses") {
		t.Errorf("unknown harness should be rejected, got %v", errFields(b))
	}
}

func TestValidateSubmitPromptRequiresTemplate(t *testing.T) {
	b := body(map[string]any{
		"name": "p", "version": "1.0.0", "description": "d", "owner": "o", "category": "general",
	})
	validateSubmit(Families["prompts"], b)
	if !hasErr(b, "missing", "template") {
		t.Errorf("want missing template, got %v", errFields(b))
	}
}

func TestNormalizeSkillPath(t *testing.T) {
	cases := []struct{ in, want string }{
		{"SKILL.md", ""},
		{"skill.md", ""},
		{"/SKILL.md/", ""},
		{"tools/review/SKILL.md", "tools/review"},
		{"tools/review/skill.md", "tools/review"},
		{"/tools/review/", "tools/review"},
		{"tools", "tools"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := normalizeSkillPath(tc.in); got != tc.want {
			t.Errorf("normalizeSkillPath(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestBuildRawSkillURL(t *testing.T) {
	cases := []struct{ gitURL, skillPath, ref, want string }{
		{"https://github.com/acme/skills", "", "main",
			"https://raw.githubusercontent.com/acme/skills/main/SKILL.md"},
		{"https://github.com/acme/skills.git", "review/SKILL.md", "v2",
			"https://raw.githubusercontent.com/acme/skills/v2/review/SKILL.md"},
		{"git@github.com:acme/skills.git", "review", "main",
			"https://raw.githubusercontent.com/acme/skills/main/review/SKILL.md"},
		{"https://gitlab.example.com/acme/skills.git", "review", "main",
			"https://gitlab.example.com/acme/skills/raw/main/review/SKILL.md"},
	}
	for _, tc := range cases {
		if got := buildRawSkillURL(tc.gitURL, tc.skillPath, tc.ref); got != tc.want {
			t.Errorf("buildRawSkillURL(%q, %q, %q) = %q, want %q", tc.gitURL, tc.skillPath, tc.ref, got, tc.want)
		}
	}
}

func TestNormalizeSlashCommand(t *testing.T) {
	if got, err := normalizeSlashCommand(""); got != "" || err != nil {
		t.Errorf("empty command: got %q, %v", got, err)
	}
	if got, err := normalizeSlashCommand("/review-code"); got != "review-code" || err != nil {
		t.Errorf("leading slash: got %q, %v", got, err)
	}
	for _, bad := range []string{"Review", "-lead", "a b", "/", strings.Repeat("a", 65)} {
		if _, err := normalizeSlashCommand(bad); err == nil || err.Status != 422 {
			t.Errorf("normalizeSlashCommand(%q): want 422, got %v", bad, err)
		}
	}
}

func TestSkillFrontmatterMap(t *testing.T) {
	if m, err := skillFrontmatterMap("no frontmatter here"); err != nil || len(m) != 0 {
		t.Errorf("plain content: got %v, %v", m, err)
	}
	m, err := skillFrontmatterMap("---\nname: review\ncommand: /review\n---\nBody")
	if err != nil || m["name"] != "review" {
		t.Errorf("valid mapping: got %v, %v", m, err)
	}
	if _, err := skillFrontmatterMap("---\njust a scalar\n---\n"); err == nil || err.Status != 422 {
		t.Errorf("scalar frontmatter: want 422, got %v", err)
	}
	if _, err := skillFrontmatterMap("---\nname: [unclosed\n---\n"); err == nil || err.Status != 422 {
		t.Errorf("malformed frontmatter: want 422, got %v", err)
	}
}
