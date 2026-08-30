// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"strings"
	"testing"
)

func TestInsertStmtRawValSQL(t *testing.T) {
	stmt := &insertStmt{}
	stmt.raw("id", "gen_random_uuid()")
	stmt.val("name", "weather")
	stmt.val("co_authors", []string{"u1", "u2"}) // JSON column gets a ::json cast
	if stmt.err != nil {
		t.Fatalf("val error: %v", stmt.err)
	}
	sql := stmt.sql("mcp_listings")
	want := "INSERT INTO mcp_listings (id, name, co_authors) VALUES (gen_random_uuid(), $1, $2::json) RETURNING id::text"
	if sql != want {
		t.Errorf("sql =\n  %s\nwant\n  %s", sql, want)
	}
	if len(stmt.vals) != 2 {
		t.Errorf("vals = %d, want 2 (raw expr binds no value)", len(stmt.vals))
	}
	// The co_authors slice is marshalled to a JSON string, not passed raw.
	if _, ok := stmt.vals[1].(string); !ok {
		t.Errorf("json column value type = %T, want string", stmt.vals[1])
	}
}

func TestValidationErrorMessage(t *testing.T) {
	err := &validationError{Errs: []fieldError{{Type: "missing"}}}
	if err.Error() != "request validation failed" {
		t.Errorf("message = %q", err.Error())
	}
}

func TestAPIErrorMessage(t *testing.T) {
	err := &apiError{Status: 409, Detail: "conflict"}
	if err.Error() != "conflict" {
		t.Errorf("message = %q", err.Error())
	}
}

func TestNamedEntryList(t *testing.T) {
	// Absent + nullable renders NULL; absent + non-nullable renders an empty slice.
	if got := draftBodyOf(map[string]any{}).namedEntryList("headers", true); got != nil {
		t.Errorf("absent nullable = %v, want nil", got)
	}
	empty := draftBodyOf(map[string]any{}).namedEntryList("environment_variables", false)
	if entries, ok := empty.([]namedEntry); !ok || len(entries) != 0 {
		t.Errorf("absent non-nullable = %v", empty)
	}

	// A well-formed list keeps names, descriptions, and the required flag.
	b := draftBodyOf(map[string]any{"environment_variables": []any{
		map[string]any{"name": "API_KEY", "description": "secret", "required": false},
		map[string]any{"name": "REGION"},
	}})
	got := b.namedEntryList("environment_variables", false).([]namedEntry)
	if len(got) != 2 || len(b.errs) != 0 {
		t.Fatalf("valid list = %v errs %v", got, b.errs)
	}
	if got[0].Name != "API_KEY" || got[0].Description != "secret" || got[0].Required {
		t.Errorf("entry 0: %+v", got[0])
	}
	if got[1].Name != "REGION" || !got[1].Required {
		t.Errorf("entry 1 default required: %+v", got[1])
	}

	// A scalar payload is a list_type error.
	scalar := draftBodyOf(map[string]any{"environment_variables": "nope"})
	scalar.namedEntryList("environment_variables", false)
	if len(scalar.errs) == 0 || scalar.errs[0].Type != "list_type" {
		t.Errorf("scalar errs = %v", scalar.errs)
	}

	// A member missing its name is skipped with a missing error.
	noName := draftBodyOf(map[string]any{"environment_variables": []any{map[string]any{"description": "x"}}})
	out := noName.namedEntryList("environment_variables", false).([]namedEntry)
	if len(out) != 0 || len(noName.errs) == 0 || noName.errs[0].Type != "missing" {
		t.Errorf("missing name: out=%v errs=%v", out, noName.errs)
	}
}

func TestDraftVersionFieldsPrompts(t *testing.T) {
	b := draftBodyOf(map[string]any{
		"description": "a greeter", "category": "chat",
		"template": "Hi {{name}}", "tags": []any{"greeting"},
	})
	fields := draftVersionFields(Families["prompts"], b, []string{"kiro"})
	if fields["description"] != "a greeter" || fields["category"] != "chat" {
		t.Errorf("prompt fields: %v", fields)
	}
	if fields["template"] != "Hi {{name}}" {
		t.Errorf("template: %v", fields["template"])
	}
}

func TestDraftVersionFieldsMcpTransportInference(t *testing.T) {
	// Remote-only drafts infer sse transport.
	remote := draftBodyOf(map[string]any{"url": "https://x.example"})
	fields := draftVersionFields(Families["mcps"], remote, []string{"kiro"})
	if tp, _ := fields["transport"].(*string); tp == nil || *tp != "sse" {
		t.Errorf("remote transport = %v, want sse", fields["transport"])
	}

	// Command drafts infer stdio transport.
	local := draftBodyOf(map[string]any{"command": "run.sh"})
	fields = draftVersionFields(Families["mcps"], local, []string{"kiro"})
	if tp, _ := fields["transport"].(*string); tp == nil || *tp != "stdio" {
		t.Errorf("command transport = %v, want stdio", fields["transport"])
	}
}

func TestDraftVersionFieldsHookDefaults(t *testing.T) {
	b := draftBodyOf(map[string]any{})
	fields := draftVersionFields(Families["hooks"], b, []string{"kiro"})
	if fields["event"] != "PreToolUse" || fields["execution_mode"] != "async" {
		t.Errorf("hook defaults: %v", fields)
	}
	if fields["priority"] != 100 || fields["handler_type"] != "command" {
		t.Errorf("hook handler defaults: %v", fields)
	}
	if !strings.EqualFold(fields["scope"].(string), "agent") {
		t.Errorf("hook scope default: %v", fields["scope"])
	}
}
