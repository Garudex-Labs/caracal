// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import "testing"

// A registry MCP command carrying shell metacharacters is rejected at submit.
func TestValidateSubmitMCPRejectsShellMetacharacters(t *testing.T) {
	raw := validMCPBody()
	raw["command"] = "npx"
	raw["args"] = []any{"x; rm -rf ~"}
	b := body(raw)
	validateSubmit(Families["mcps"], b)
	if !hasErr(b, "value_error", "command") {
		t.Errorf("shell-meta command must be rejected at submit: %v", errFields(b))
	}
}

// Interpreter launchers stay valid for registry MCPs (git analysis emits
// `command: python`); only shell injection is refused, unlike external MCPs.
func TestValidateSubmitMCPAllowsInterpreterCommand(t *testing.T) {
	raw := validMCPBody()
	raw["command"] = "python"
	raw["args"] = []any{"-m", "weather_server"}
	b := body(raw)
	validateSubmit(Families["mcps"], b)
	if len(b.errs) != 0 {
		t.Errorf("interpreter command must pass for a registry MCP: %v", errFields(b))
	}
}

// The edit path validates the same way as submit.
func TestUpdateVersionFieldsMCPRejectsShellMetacharacters(t *testing.T) {
	b := body(map[string]any{"command": "npx", "args": []any{"`id`"}})
	u := &updateSpec{}
	updateVersionFields(Families["mcps"], b, nil, u)
	if !hasErr(b, "value_error", "command") {
		t.Errorf("edit must reject shell-meta command: %v", errFields(b))
	}
}

// The version-publish path validates the same way as submit.
func TestValidateVersionExtrasMCPRejectsShellMetacharacters(t *testing.T) {
	_, aerr := validateVersionExtras(Families["mcps"], map[string]any{
		"command": "sh", "args": []any{"-c", "a|b"},
	})
	if aerr == nil || aerr.Status != 422 {
		t.Fatalf("publish must reject shell-meta command, got %v", aerr)
	}
}
