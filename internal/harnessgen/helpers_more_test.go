// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"reflect"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/harness"
)

func TestSortedKeys(t *testing.T) {
	got := sortedKeys(map[string]string{"c": "", "a": "", "b": ""})
	if !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Errorf("sortedKeys = %v", got)
	}
	if got := sortedKeys(map[string]string{}); len(got) != 0 {
		t.Errorf("empty map = %v", got)
	}
}

func TestStrHelper(t *testing.T) {
	if str("x") != "x" || str(5) != "" || str(nil) != "" {
		t.Error("str type assertion broken")
	}
}

func TestRespaceJSON(t *testing.T) {
	if got := respaceJSON([]byte(`{"a":1,"b":2}`)); got != `{"a": 1, "b": 2}` {
		t.Errorf("respaceJSON = %q", got)
	}
	// Separators inside strings are preserved verbatim.
	if got := respaceJSON([]byte(`{"a:b":"c,d"}`)); got != `{"a:b": "c,d"}` {
		t.Errorf("in-string separators altered: %q", got)
	}
	// An escaped quote must not flip string state.
	if got := respaceJSON([]byte(`{"a":"x\"y","b":1}`)); got != `{"a": "x\"y", "b": 1}` {
		t.Errorf("escaped quote mishandled: %q", got)
	}
}

func TestJSONNumber(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{float64(5), "5"},
		{float64(5.5), "5.5"},
		{7, "7"},
		{"z", "z"},
	}
	for _, tc := range cases {
		if got := jsonNumber(tc.in); got != tc.want {
			t.Errorf("jsonNumber(%v) = %q want %q", tc.in, got, tc.want)
		}
	}
}

func TestHarnessCapability(t *testing.T) {
	if harnessCapability("hooks") != harness.Capability("hooks") {
		t.Error("harnessCapability did not wrap the name")
	}
}

func TestModelNameToFrontmatter(t *testing.T) {
	cases := map[string]string{
		"claude-3-5-sonnet": "sonnet",
		"claude-opus-4":     "opus",
		"gpt-4o":            "gpt-4o",
		"":                  "",
	}
	for in, want := range cases {
		if got := modelNameToFrontmatter(in); got != want {
			t.Errorf("modelNameToFrontmatter(%q) = %q want %q", in, got, want)
		}
	}
}

func TestDigitHelpers(t *testing.T) {
	if !isDigits("123") || isDigits("1a") || isDigits("") {
		t.Error("isDigits broken")
	}
	if !isShortDigits("12") || isShortDigits("1234") || isShortDigits("") || isShortDigits("ab") {
		t.Error("isShortDigits broken")
	}
}

func TestEmptyValue(t *testing.T) {
	if !emptyValue(map[string]any{}) || !emptyValue(map[string]string{}) || !emptyValue(nil) {
		t.Error("empty containers should be empty")
	}
	if emptyValue(map[string]any{"a": 1}) || emptyValue(5) {
		t.Error("non-empty values misreported")
	}
}

func TestAnyListOrEmpty(t *testing.T) {
	if got := anyListOrEmpty(nil); got == nil || len(got) != 0 {
		t.Errorf("nil should yield empty non-nil slice, got %v", got)
	}
	if got := anyListOrEmpty([]any{1, 2}); len(got) != 2 {
		t.Errorf("[]any passthrough = %v", got)
	}
	if got := anyListOrEmpty([]string{"a"}); len(got) != 1 {
		t.Errorf("[]string conversion = %v", got)
	}
}

func TestDictOrEmpty(t *testing.T) {
	if got := dictOrEmpty(map[string]any{"a": 1}); len(got.(map[string]any)) != 1 {
		t.Errorf("map[string]any passthrough = %v", got)
	}
	if got := dictOrEmpty(map[string]string{"a": "b"}); len(got.(map[string]string)) != 1 {
		t.Errorf("map[string]string passthrough = %v", got)
	}
	if got := dictOrEmpty(5); len(got.(map[string]any)) != 0 {
		t.Errorf("scalar should yield empty map, got %v", got)
	}
}

func TestYamlFrontmatterRaw(t *testing.T) {
	got := yamlFrontmatterRaw([][2]string{{"description", "d"}, {"alwaysApply", "false"}})
	want := "---\ndescription: d\nalwaysApply: false\n---\n\n"
	if got != want {
		t.Errorf("yamlFrontmatterRaw = %q want %q", got, want)
	}
	// A boolean value is emitted unquoted, a scalar is quoted when ambiguous.
	got = yamlFrontmatterRaw([][2]string{{"k", "a: b"}})
	if !strings.Contains(got, "k: 'a: b'") {
		t.Errorf("ambiguous scalar not quoted: %q", got)
	}
}

func TestConfigStoredJSONAndDelete(t *testing.T) {
	c := NewConfig()
	c.Set("a", 1)
	c.Set("b", "x")
	got, err := c.StoredJSON()
	if err != nil {
		t.Fatal(err)
	}
	if got != `{"a": 1, "b": "x"}` {
		t.Errorf("StoredJSON = %q", got)
	}

	c.Set("c", 3)
	c.Delete("b")
	if !reflect.DeepEqual(c.Keys(), []string{"a", "c"}) {
		t.Errorf("Delete did not preserve order: %v", c.Keys())
	}
	if _, ok := c.Get("b"); ok {
		t.Error("deleted key still present")
	}
	// Deleting an absent key is a no-op.
	c.Delete("missing")
	if c.Len() != 2 {
		t.Errorf("no-op delete changed length: %d", c.Len())
	}
}

func TestListingDict(t *testing.T) {
	l := Listing{"d": map[string]any{"k": "v"}}
	if got := l.dict("d"); got["k"] != "v" {
		t.Errorf("Listing.dict = %v", got)
	}
	if got := l.dict("missing"); got != nil {
		t.Errorf("missing key should be nil, got %v", got)
	}
}

func TestHookInstallNotes(t *testing.T) {
	if len(HookInstallNotes("claude-code")) != 1 {
		t.Error("claude-code should carry an install note")
	}
	if len(HookInstallNotes("kiro")) != 0 {
		t.Error("kiro should carry no install notes")
	}
}

func TestSkillHookExtra(t *testing.T) {
	extra := SkillHookExtra("claude-code")
	if _, ok := extra["allowedEnvVars"]; !ok {
		t.Errorf("claude-code skill hook extra = %v", extra)
	}
	if len(SkillHookExtra("kiro")) != 0 {
		t.Error("kiro should carry no skill hook extras")
	}
}

func TestSkillFilePath(t *testing.T) {
	if got := SkillFilePath("claude-code", "project", "reviewer"); got != ".claude/skills/reviewer/SKILL.md" {
		t.Errorf("claude-code project skill path = %q", got)
	}
	// An unknown scope falls back to the sorted-first template deterministically.
	if got := SkillFilePath("claude-code", "no-such-scope", "reviewer"); got == "" || !strings.Contains(got, "reviewer") {
		t.Errorf("scope fallback path = %q", got)
	}
	if got := SkillFilePath("cursor", "project", "x"); got != ".cursor/skills/x/SKILL.md" {
		t.Errorf("cursor skill path = %q", got)
	}
	if got := SkillFilePath("nonexistent-harness", "project", "x"); got != "" {
		t.Errorf("unknown harness has no skills, want empty, got %q", got)
	}
}

func TestSanitizeComponentName(t *testing.T) {
	if got := SanitizeComponentName("My MCP!"); got != "My-MCP-" {
		t.Errorf("SanitizeComponentName = %q", got)
	}
	if got := SanitizeComponentName("already-safe_1"); got != "already-safe_1" {
		t.Errorf("safe name altered: %q", got)
	}
}

func TestHarnessSpecAndNames(t *testing.T) {
	if _, ok := HarnessSpec("claude-code"); !ok {
		t.Error("claude-code spec should resolve")
	}
	// Underscore form normalizes to the hyphenated registry key.
	if _, ok := HarnessSpec("copilot_cli"); !ok {
		t.Error("copilot_cli should normalize to copilot-cli")
	}
	if _, ok := HarnessSpec("nope"); ok {
		t.Error("unknown harness should not resolve")
	}

	if len(RegistryHarnessNames()) == 0 {
		t.Error("registry harness names empty")
	}
	names := HarnessNames()
	if len(names) != len(adapters) {
		t.Errorf("HarnessNames len = %d want %d", len(names), len(adapters))
	}
	for i := 1; i < len(names); i++ {
		if names[i-1] > names[i] {
			t.Errorf("HarnessNames not sorted: %v", names)
			break
		}
	}
}
