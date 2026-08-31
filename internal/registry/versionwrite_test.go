// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"strings"
	"testing"
)

func TestParseSemverTuple(t *testing.T) {
	cases := []struct {
		in   string
		want [3]int
	}{
		{"1.2.3", [3]int{1, 2, 3}},
		{"2.0.0-rc.1", [3]int{2, 0, 0}},
		{"1.2", [3]int{1, 2, 0}},
		{"garbage", [3]int{0, 0, 0}},
		{"1.x.3", [3]int{0, 0, 0}},
		{"", [3]int{0, 0, 0}},
	}
	for _, tc := range cases {
		if got := parseSemverTuple(tc.in); got != tc.want {
			t.Errorf("parseSemverTuple(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestSemverGTE(t *testing.T) {
	cases := []struct {
		a, b [3]int
		want bool
	}{
		{[3]int{2, 0, 0}, [3]int{1, 9, 9}, true},
		{[3]int{1, 2, 3}, [3]int{1, 2, 3}, true},
		{[3]int{1, 2, 3}, [3]int{1, 2, 4}, false},
		{[3]int{1, 3, 0}, [3]int{1, 2, 9}, true},
		{[3]int{0, 9, 0}, [3]int{1, 0, 0}, false},
	}
	for _, tc := range cases {
		if got := semverGTE(tc.a, tc.b); got != tc.want {
			t.Errorf("semverGTE(%v, %v) = %v", tc.a, tc.b, got)
		}
	}
}

func TestMatchesExtraType(t *testing.T) {
	cases := []struct {
		expected string
		v        any
		ok       bool
		got      string
	}{
		{"str", "x", true, "str"},
		{"str", 1.0, false, "float"},
		{"dict", map[string]any{}, true, "dict"},
		{"list", []any{}, true, "list"},
		{"bool", true, true, "bool"},
		// JSON integers arrive as float64 and pass only when whole.
		{"integer", 3.0, true, "int"},
		{"integer", 3.5, false, "float"},
		{"integer", true, false, "bool"},
		{"integer", "3", false, "str"},
	}
	for _, tc := range cases {
		ok, got := matchesExtraType(tc.expected, tc.v)
		if ok != tc.ok || got != tc.got {
			t.Errorf("matchesExtraType(%q, %v) = (%v, %q), want (%v, %q)",
				tc.expected, tc.v, ok, got, tc.ok, tc.got)
		}
	}
}

func wantExtraErr(t *testing.T, f Family, extra map[string]any, detail string) {
	t.Helper()
	_, aerr := validateVersionExtras(f, extra)
	if aerr == nil || aerr.Status != 422 || aerr.Detail != detail {
		t.Errorf("validateVersionExtras(%s, %v): got %v, want 422 %q", f.Prefix, extra, aerr, detail)
	}
}

func TestValidateVersionExtrasRequiredAndUnknown(t *testing.T) {
	hooks := Families["hooks"]

	wantExtraErr(t, hooks, map[string]any{},
		"Missing required fields for hook: event, handler_type")
	wantExtraErr(t, hooks, map[string]any{"event": "Stop", "handler_type": "command", "bogus": 1, "alpha": 1},
		"Unknown fields for hook: alpha, bogus")
	wantExtraErr(t, hooks, map[string]any{"event": "Stop"},
		"Missing required fields for hook: handler_type")
	wantExtraErr(t, hooks, map[string]any{"event": "", "handler_type": "command"},
		"Required field 'event' cannot be empty")

	// Families without required extras accept an empty map.
	clean, aerr := validateVersionExtras(Families["mcps"], map[string]any{})
	if aerr != nil || len(clean) != 0 {
		t.Errorf("mcps empty extras: %v, %v", clean, aerr)
	}
}

func TestValidateVersionExtrasTypeContract(t *testing.T) {
	hooks := Families["hooks"]
	base := func() map[string]any {
		return map[string]any{"event": "Stop", "handler_type": "command"}
	}

	raw := base()
	raw["priority"] = "high"
	wantExtraErr(t, hooks, raw, "Field 'priority' must be a integer, got str")

	raw = base()
	raw["priority"] = true
	wantExtraErr(t, hooks, raw, "Field 'priority' must be an integer, got bool")

	raw = base()
	raw["handler_config"] = "not a dict"
	wantExtraErr(t, hooks, raw, "Field 'handler_config' must be a dict, got str")

	// Null optional values are skipped, whole floats pass as integers.
	raw = base()
	raw["priority"] = 5.0
	raw["tool_filter"] = nil
	if _, aerr := validateVersionExtras(hooks, raw); aerr != nil {
		t.Errorf("valid extras rejected: %v", aerr)
	}
}

func TestValidateVersionExtrasSkillSlashNormalization(t *testing.T) {
	skills := Families["skills"]

	clean, aerr := validateVersionExtras(skills, map[string]any{
		"task_type": "review", "slash_command": "/review-code",
	})
	if aerr != nil || clean["slash_command"] != "review-code" {
		t.Errorf("slash normalization: %v, %v", clean, aerr)
	}

	_, aerr = validateVersionExtras(skills, map[string]any{
		"task_type": "review", "slash_command": "/Bad Command",
	})
	if aerr == nil || !strings.HasPrefix(aerr.Detail, "Invalid skill metadata: ") {
		t.Errorf("invalid slash command: %v", aerr)
	}

	// A frontmatter command in SKILL.md fills the clean map.
	clean, aerr = validateVersionExtras(skills, map[string]any{
		"task_type":        "review",
		"skill_md_content": "---\nname: reviewer\ncommand: /review\n---\nBody",
	})
	if aerr != nil || clean["slash_command"] != "review" {
		t.Errorf("frontmatter command: %v, %v", clean, aerr)
	}
}
