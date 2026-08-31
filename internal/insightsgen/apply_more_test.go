// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestApplyErrorRendersDetail(t *testing.T) {
	err := &ApplyError{Status: 404, Detail: "Report not found"}
	if err.Error() != "Report not found" {
		t.Errorf("Error() = %q", err.Error())
	}
}

func TestSuggestionClassifiers(t *testing.T) {
	if !isSkillSuggestion(map[string]any{"feature": "Create a custom SKILL"}) {
		t.Error("skill mention not detected")
	}
	if isSkillSuggestion(map[string]any{"feature": "something else"}) {
		t.Error("non-skill misdetected")
	}
	for _, hooky := range []string{"add a hook", "lifecycle automation", "pre-commit check"} {
		if !isHookSuggestion(map[string]any{"feature": hooky}) {
			t.Errorf("%q must classify as hook", hooky)
		}
	}
	if isHookSuggestion(map[string]any{"feature": "plain feature"}) {
		t.Error("non-hook misdetected")
	}
	for _, mcpy := range []string{"install the github MCP", "run a server"} {
		if !isMcpSuggestion(map[string]any{"feature": mcpy}) {
			t.Errorf("%q must classify as mcp", mcpy)
		}
	}
}

func TestDeclaredComponentType(t *testing.T) {
	cases := []struct {
		feature map[string]any
		want    string
	}{
		{map[string]any{"feature": "reuse this skill"}, "skill"},
		{map[string]any{"feature": "a lifecycle hook"}, "hook"},
		{map[string]any{"feature": "the github mcp"}, "mcp"},
		{map[string]any{"feature": "reusable prompt template"}, "prompt"},
		{map[string]any{"feature": "totally ambiguous"}, ""},
	}
	for _, tc := range cases {
		if got := declaredComponentType(tc.feature); got != tc.want {
			t.Errorf("declaredComponentType(%v) = %q, want %q", tc.feature, got, tc.want)
		}
	}
}

func TestApplyVisibilitySQLBindsParam(t *testing.T) {
	sql := applyVisibilitySQL("$3")
	if !strings.Contains(sql, "l.submitted_by = $3") {
		t.Errorf("owner arm must bind the given param: %s", sql)
	}
	if !strings.Contains(sql, "l.is_private = FALSE") {
		t.Errorf("public arm missing: %s", sql)
	}
}

func TestApplySearchTokens(t *testing.T) {
	got := applySearchTokens("Please find skills that help with Postgres migrations and go")
	// Stop words drop, plurals singularize, tiny tokens drop except the
	// allow list, order and dedupe are stable.
	want := []string{"postgre", "migration", "go"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tokens = %v, want %v", got, want)
	}
	if got := applySearchTokens("the and with for"); len(got) != 0 {
		t.Errorf("all-stopword query must yield nothing: %v", got)
	}
	if got := applySearchTokens("boss pass"); !reflect.DeepEqual(got, []string{"boss", "pass"}) {
		t.Errorf("-ss words must not be singularized: %v", got)
	}
}

func TestApplyLikeEscape(t *testing.T) {
	if got := applyLikeEscape(`50%_a\b`); got != `50\%\_a\\b` {
		t.Errorf("escape = %q", got)
	}
}

func TestApplySlug(t *testing.T) {
	cases := map[string]string{
		"Custom Skill for the Team!": "skill-team",
		"  Hello World  ":            "hello-world",
		"a-an-the":                   "",
		"multi   spaces":             "multi-spaces",
	}
	for in, want := range cases {
		if got := applySlug(in); got != want {
			t.Errorf("applySlug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestApplyExtractKeywords(t *testing.T) {
	got := applyExtractKeywords("Automatically runs the linter before every custom commit", 3)
	if got != "automatically-runs-linter" {
		t.Errorf("keywords = %q", got)
	}
	if got := applyExtractKeywords("a an to of", 4); got != "" {
		t.Errorf("stopword-only text = %q", got)
	}
}

func TestApplyDeriveName(t *testing.T) {
	got := applyDeriveName("Review Bot", "Automatically lint the changed files")
	if got != "review-bot-automatically-lint-changed-files" {
		t.Errorf("derived = %q", got)
	}
	if len(got) > applyMaxNameLen {
		t.Errorf("derived name too long: %d", len(got))
	}
	if got := applyDeriveName("", ""); got != "unnamed" {
		t.Errorf("empty everything = %q", got)
	}
	// A very long agent prefix leaves no room; the label wins.
	long := applyDeriveName(strings.Repeat("agent-name-", 8), "short label")
	if len(long) > applyMaxNameLen {
		t.Errorf("long prefix result too long: %q", long)
	}
}

func TestPreferredComponentName(t *testing.T) {
	agent := &applyAgent{name: "Review Bot"}
	got := preferredComponentName(agent, map[string]any{"name": "lint-fix"}, "", "skill")
	if got != "review-bot-lint-fix" {
		t.Errorf("short valid name = %q", got)
	}
	// Invalid model names fall back to derivation from the label.
	got = preferredComponentName(agent, map[string]any{"name": "Not A Slug!!"}, "runs the linter", "skill")
	if !strings.HasPrefix(got, "review-bot-") {
		t.Errorf("derived name = %q", got)
	}
	// No name, no one-liner, no feature: the kind is the label.
	got = preferredComponentName(agent, map[string]any{}, "", "skill")
	if got != "review-bot-skill" {
		t.Errorf("kind fallback = %q", got)
	}
}

func TestRegistrySlug(t *testing.T) {
	if got, err := registrySlug("  My Skill  "); err != nil || got != "my-skill" {
		t.Errorf("basic slug: %q %v", got, err)
	}
	if _, err := registrySlug("!!!"); err == nil {
		t.Error("symbol-only name must fail")
	}
	if _, err := registrySlug("draft"); err == nil {
		t.Error("reserved slug must fail")
	}
	long, err := registrySlug(strings.Repeat("a", 100))
	if err != nil || len(long) != 64 {
		t.Errorf("long slug = %q (%d) %v", long, len(long), err)
	}
}

func TestEnsureSkillMDFormat(t *testing.T) {
	passthrough := "---\nname: x\n---\nbody"
	if got := ensureSkillMDFormat("n", "d", passthrough); got != passthrough {
		t.Errorf("existing frontmatter must pass through: %q", got)
	}
	wrapped := ensureSkillMDFormat("my-skill", "does things", "raw example")
	for _, frag := range []string{"---\n", "name: my-skill", "description: does things", "version: 1.0.0", "# my-skill", "raw example"} {
		if !strings.Contains(wrapped, frag) {
			t.Errorf("wrapped SKILL.md missing %q:\n%s", frag, wrapped)
		}
	}
}

func TestValidateSkillMDFrontmatter(t *testing.T) {
	valid := []string{
		"",
		"no frontmatter at all",
		"---\nname: x\ncommand: /review\n---\nbody",
		"---\ncommand: fix_this-1\n---\nbody",
		"---\n\n---\nbody",
	}
	for _, content := range valid {
		if err := validateSkillMDFrontmatter(content); err != nil {
			t.Errorf("%q must validate: %v", content, err)
		}
	}
	invalid := []string{
		"---\nunterminated",
		"---\n---\nbody",
		"---\n- just\n- a list\n---\nbody",
		"---\ncommand: \"UPPER CASE\"\n---\nbody",
		"---\ncommand: 42\n---\nbody",
		"---\n{broken yaml\n---\nbody",
	}
	for _, content := range invalid {
		if err := validateSkillMDFrontmatter(content); err == nil {
			t.Errorf("%q must be rejected", content)
		}
	}
}

func TestSplitTextLines(t *testing.T) {
	if got := splitTextLines(""); got != nil {
		t.Errorf("empty = %v", got)
	}
	got := splitTextLines("a\r\nb\rc\n")
	if !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Errorf("mixed line endings = %v", got)
	}
}

func TestParseHookExample(t *testing.T) {
	cases := []struct {
		example   string
		wantEvent string
		wantMode  string
	}{
		{"# hook: run before commit\ngit diff", "Stop", "blocking"},
		{"# hook: on session start\necho hi", "SessionStart", "async"},
		{"# hook: on prompt submit\necho hi", "UserPromptSubmit", "sync"},
		{"# hook: pre tool use\necho hi", "PreToolUse", "sync"},
		{"# hook: post tool use\necho hi", "PostToolUse", "async"},
		{"# hook: something else\necho hi", "Stop", "async"},
		{"just a script", "Stop", "async"},
	}
	for _, tc := range cases {
		event, mode, script := parseHookExample(tc.example)
		if event != tc.wantEvent || mode != tc.wantMode {
			t.Errorf("parseHookExample(%q) = %s/%s, want %s/%s", tc.example, event, mode, tc.wantEvent, tc.wantMode)
		}
		if strings.Contains(script, "# hook:") {
			t.Errorf("annotation must not leak into the script: %q", script)
		}
	}
	// A hook-annotation-only example falls back to the raw text.
	_, _, script := parseHookExample("# hook: run before commit")
	if script != "# hook: run before commit" {
		t.Errorf("annotation-only fallback = %q", script)
	}
}

func TestNormalizeHookScript(t *testing.T) {
	shebang := "#!/bin/sh\necho hi"
	if got := normalizeHookScript(shebang, "n"); got != shebang {
		t.Errorf("shebang scripts pass through: %q", got)
	}
	shell := normalizeHookScript("git diff --stat\npytest -q", "my-hook")
	if !strings.HasPrefix(shell, "#!/usr/bin/env bash") || !strings.Contains(shell, "git diff --stat") {
		t.Errorf("shell wrapper: %q", shell)
	}
	python := normalizeHookScript("import os\ndef main():\n    return {}", "my-hook")
	if !strings.HasPrefix(python, "#!/usr/bin/env python3") || !strings.Contains(python, "Review and adapt") {
		t.Errorf("python wrapper: %q", python)
	}
	placeholder := normalizeHookScript("verify the answer is polite", "my-hook")
	if !strings.Contains(placeholder, "# TODO: Implement the following logic:") ||
		!strings.Contains(placeholder, "# verify the answer is polite") ||
		!strings.Contains(placeholder, `echo "[my-hook] Hook executed successfully"`) {
		t.Errorf("placeholder wrapper: %q", placeholder)
	}
}

func TestBumpPatchVersion(t *testing.T) {
	cases := map[string]string{
		"1.2.3":   "1.2.4",
		"0.0.9":   "0.0.10",
		"":        "1.0.0",
		"v1.2.3":  "1.0.0",
		"1.2":     "1.0.0",
		"1.02.3":  "1.0.0",
		"10.0.99": "10.0.100",
	}
	for in, want := range cases {
		if got := bumpPatchVersion(in); got != want {
			t.Errorf("bumpPatchVersion(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBuildAdditionsText(t *testing.T) {
	got := buildAdditionsText([]map[string]any{
		{"addition": "Always run tests", "where": "system_prompt", "why": "safety"},
		{"addition": "  ", "where": "system_prompt"},
		{"addition": "Skip me", "where": "somewhere_else"},
		{"addition": "No why given"},
	})
	if !strings.Contains(got, "# Reason: safety\nAlways run tests") {
		t.Errorf("reason and addition missing:\n%s", got)
	}
	if strings.Contains(got, "Skip me") {
		t.Errorf("unknown placement must be dropped:\n%s", got)
	}
	if !strings.Contains(got, "No why given") {
		t.Errorf("missing where defaults to system_prompt:\n%s", got)
	}
}

func TestListingSubject(t *testing.T) {
	agent := &applyAgent{namespace: "acme", name: "Review Bot"}
	listingID := uuid.New()
	subject := listingSubject("skill", listingID.String(), "my-skill", agent, "my-skill", "1.0.0")
	if subject.Type != "skill" || subject.Name != "my-skill" || subject.IsPrivate {
		t.Errorf("subject = %+v", subject)
	}
	if subject.ID == nil || *subject.ID != listingID {
		t.Errorf("subject.ID = %v", subject.ID)
	}
	if *subject.Namespace != "acme" || *subject.Slug != "my-skill" || *subject.Version != "1.0.0" {
		t.Errorf("identity fields: %+v", subject)
	}
	// A non-UUID listing id leaves the subject id unset.
	subject = listingSubject("hook", "not-a-uuid", "n", agent, "s", "1.0.0")
	if subject.ID != nil {
		t.Errorf("bad id must not set subject.ID: %v", subject.ID)
	}
}
