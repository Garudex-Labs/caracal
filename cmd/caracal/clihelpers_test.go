// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestStripFlags(t *testing.T) {
	cases := []struct {
		in   []string
		want []string
	}{
		{[]string{"registry", "mcp", "list"}, []string{"registry", "mcp", "list"}},
		{[]string{"registry", "-o", "json"}, []string{"registry"}},
		{[]string{"--output=json", "registry"}, nil},
		{nil, []string{}},
	}
	for _, tc := range cases {
		got := stripFlags(tc.in)
		if strings.Join(got, " ") != strings.Join(tc.want, " ") {
			t.Errorf("stripFlags(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestJSONErrorsRequested(t *testing.T) {
	cases := []struct {
		in   []string
		want bool
	}{
		{[]string{"--output=json"}, true},
		{[]string{"-ojson"}, true},
		{[]string{"--output", "json"}, true},
		{[]string{"-o", "json"}, true},
		{[]string{"-o", "table"}, false},
		{[]string{"registry", "mcp", "list"}, false},
		{[]string{"--output"}, false},
	}
	for _, tc := range cases {
		if got := jsonErrorsRequested(tc.in); got != tc.want {
			t.Errorf("jsonErrorsRequested(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestDebugRequested(t *testing.T) {
	t.Setenv("CARACAL_DEBUG", "")
	if debugRequested() {
		t.Error("empty CARACAL_DEBUG must not request debug")
	}
	t.Setenv("CARACAL_DEBUG", "1")
	if !debugRequested() {
		t.Error("non-empty CARACAL_DEBUG must request debug")
	}
}

func TestParseReleaseTriple(t *testing.T) {
	cases := []struct {
		in   string
		want []int
	}{
		{"1.2.3", []int{1, 2, 3}},
		{"2", []int{2, 0, 0}},
		{"1.4", []int{1, 4, 0}},
		{"1.2.3.4", []int{1, 2, 3}},
		{"1.2.3+build", []int{1, 2, 3}},
	}
	for _, tc := range cases {
		got := parseReleaseTriple(tc.in)
		if len(got) != 3 || got[0] != tc.want[0] || got[1] != tc.want[1] || got[2] != tc.want[2] {
			t.Errorf("parseReleaseTriple(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
	for _, bad := range []string{"", "abc", "1.x.3", "v1.2.3"} {
		if got := parseReleaseTriple(bad); got != nil {
			t.Errorf("parseReleaseTriple(%q) = %v, want nil", bad, got)
		}
	}
}

func TestFlagNameFor(t *testing.T) {
	if flagNameFor("git_url") != "git-url" {
		t.Error("git_url must map to git-url")
	}
	if flagNameFor("name") != "name" {
		t.Error("name must stay unchanged")
	}
}

func TestApplyPublishTarget(t *testing.T) {
	payload := newOmap()
	applyPublishTarget(payload, map[string]any{"visibility": "project"})
	if payload.get("visibility") != "project" {
		t.Errorf("visibility not applied: %v", payload.get("visibility"))
	}
	empty := newOmap()
	applyPublishTarget(empty, map[string]any{})
	if empty.has("visibility") {
		t.Error("missing visibility must not be set")
	}
}

func TestParseStdinJSON(t *testing.T) {
	cfg, cerr := parseStdinJSON(`{"mcpServers": {"weather": {"command": "npx"}}}`, "Submit MCP server")
	if cerr != nil {
		t.Fatalf("valid JSON rejected: %v", cerr)
	}
	if !cfg.has("mcpServers") {
		t.Error("parsed config missing mcpServers")
	}

	// Whitespace-broken JSON recovers via the field-stripping fallback.
	if _, cerr := parseStdinJSON("{ \"a\" :\n 1 }", "Submit MCP server"); cerr != nil {
		t.Errorf("whitespace JSON should parse: %v", cerr)
	}

	if _, cerr := parseStdinJSON("", "Submit MCP server"); cerr == nil {
		t.Error("empty input must error")
	} else if cerr.Category != clierr.Validation {
		t.Errorf("category = %s", cerr.Category)
	}

	if _, cerr := parseStdinJSON("not json", "Submit MCP server"); cerr == nil {
		t.Error("invalid JSON must error")
	}

	// A JSON array is valid JSON but not an object.
	if _, cerr := parseStdinJSON("[1, 2, 3]", "Submit MCP server"); cerr == nil {
		t.Error("non-object JSON must error")
	}
}

func TestNormalizeRecommendType(t *testing.T) {
	cases := map[string]string{
		"mcp": "mcp", "mcps": "mcp", "SKILL": "skill", "skills": "skill",
		"hook": "hook", "prompts": "prompt", "sandbox": "sandbox",
	}
	for in, want := range cases {
		got, cerr := normalizeRecommendType(in, "op")
		if cerr != nil {
			t.Errorf("normalizeRecommendType(%q) errored: %v", in, cerr)
			continue
		}
		if got != want {
			t.Errorf("normalizeRecommendType(%q) = %q, want %q", in, got, want)
		}
	}
	if _, cerr := normalizeRecommendType("widget", "op"); cerr == nil {
		t.Error("unknown type must error")
	} else if !strings.Contains(cerr.Message, "widget") {
		t.Errorf("message must name the bad value: %s", cerr.Message)
	}
}

func TestFirstContentLine(t *testing.T) {
	body := "---\nname: x\ndescription: y\n---\n# Heading\n\nReal first line here.\nSecond.\n"
	if got := firstContentLine(body); got != "Real first line here." {
		t.Errorf("firstContentLine = %q", got)
	}
	if got := firstContentLine("---\nonly: frontmatter\n---\n"); got != "" {
		t.Errorf("frontmatter-only should return empty, got %q", got)
	}
	if got := firstContentLine("no frontmatter here"); got != "" {
		t.Errorf("content without a closed frontmatter block returns empty, got %q", got)
	}
	long := "---\nk: v\n---\n" + strings.Repeat("a", 250)
	if got := firstContentLine(long); len(got) != 200 {
		t.Errorf("long line must truncate to 200, got %d", len(got))
	}
}

func TestOpencodeFrontmatterField(t *testing.T) {
	body := "---\nname: reviewer\ndescription: \"quoted value\"\n---\nbody\n"
	if got := opencodeFrontmatterField(body, "name"); got != "reviewer" {
		t.Errorf("name = %q", got)
	}
	if got := opencodeFrontmatterField(body, "description"); got != "quoted value" {
		t.Errorf("quoted description = %q", got)
	}
	if got := opencodeFrontmatterField(body, "missing"); got != "" {
		t.Errorf("missing field must be empty, got %q", got)
	}
	if got := opencodeFrontmatterField("no frontmatter", "name"); got != "" {
		t.Errorf("no frontmatter must be empty, got %q", got)
	}
}

func TestInvalidServerList(t *testing.T) {
	cerr := invalidServerList("List MCP servers", "MCP registry", errBadList{})
	if cerr.Category != clierr.Unavailable {
		t.Errorf("category = %s", cerr.Category)
	}
	if cerr.Detail != "boom" {
		t.Errorf("detail = %q", cerr.Detail)
	}
}

type errBadList struct{}

func (errBadList) Error() string { return "boom" }

func TestHarnessSupportsSkills(t *testing.T) {
	if !harnessSupportsSkills("claude-code") {
		t.Error("claude-code supports skills")
	}
	if harnessSupportsSkills("cursor") {
		t.Error("cursor does not support skills")
	}
	if harnessSupportsSkills("nonexistent") {
		t.Error("unknown harness does not support skills")
	}
}

func TestStringsEqualBytes(t *testing.T) {
	if !stringsEqualBytes([]byte("abc"), []byte("abc")) {
		t.Error("equal byte slices must compare equal")
	}
	if stringsEqualBytes([]byte("abc"), []byte("abd")) {
		t.Error("different byte slices must not compare equal")
	}
}

func TestMinHelper(t *testing.T) {
	if min(3, 5) != 3 {
		t.Error("min(3,5) must be 3")
	}
	if min(5, 3) != 3 {
		t.Error("min(5,3) must be 3")
	}
	if min(4, 4) != 4 {
		t.Error("min(4,4) must be 4")
	}
}

func TestJSONAny(t *testing.T) {
	if got := jsonAny(nil); got != "null" {
		t.Errorf("jsonAny(nil) = %q", got)
	}
	if got := jsonAny("hi"); got != `"hi"` {
		t.Errorf("jsonAny string = %q", got)
	}
}

func TestCompactJSONString(t *testing.T) {
	if got := compactJSONString("a\"b"); got != `"a\"b"` {
		t.Errorf("compactJSONString = %q", got)
	}
}
