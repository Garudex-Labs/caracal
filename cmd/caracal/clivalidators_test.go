// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestRequireChoice(t *testing.T) {
	allowed := []string{"a", "b", "c"}
	if cerr := requireChoice("", allowed, "bad", "op", "res"); cerr != nil {
		t.Errorf("empty value must pass: %v", cerr)
	}
	if cerr := requireChoice("b", allowed, "bad", "op", "res"); cerr != nil {
		t.Errorf("allowed value must pass: %v", cerr)
	}
	cerr := requireChoice("z", allowed, "bad choice", "op", "res")
	if cerr == nil {
		t.Fatal("disallowed value must fail")
	}
	if cerr.Category != clierr.Validation {
		t.Errorf("category = %s", cerr.Category)
	}
	if !strings.Contains(cerr.Remediation, "a, b, c") {
		t.Errorf("remediation must list choices: %s", cerr.Remediation)
	}
}

func TestRequireVersion(t *testing.T) {
	if cerr := requireVersion("", "bad", "op"); cerr != nil {
		t.Errorf("empty version must pass: %v", cerr)
	}
	if cerr := requireVersion("1.2.3", "bad", "op"); cerr != nil {
		t.Errorf("valid version must pass: %v", cerr)
	}
	cerr := requireVersion("not-a-version!!", "The version is invalid.", "op")
	if cerr == nil {
		t.Fatal("invalid version must fail")
	}
	if cerr.Resource != "not-a-version!!" {
		t.Errorf("resource must carry the bad version: %s", cerr.Resource)
	}
}

func TestRequireHarnesses(t *testing.T) {
	if cerr := requireHarnesses([]string{"cursor", "kiro"}, "op"); cerr != nil {
		t.Errorf("valid harnesses must pass: %v", cerr)
	}
	if cerr := requireHarnesses(nil, "op"); cerr != nil {
		t.Errorf("empty list must pass: %v", cerr)
	}
	cerr := requireHarnesses([]string{"cursor", "bogus"}, "op")
	if cerr == nil {
		t.Fatal("unknown harness must fail")
	}
	if !strings.Contains(cerr.Message, "bogus") {
		t.Errorf("message must name the bad harness: %s", cerr.Message)
	}
}

func TestRequireRegistryHookHarnesses(t *testing.T) {
	for _, h := range []string{"claude-code", "cursor", "codex", "copilot", "copilot-cli", "opencode", "goose"} {
		if !harnessSupportsRegistryHooks(h) {
			t.Errorf("%s should support registry hooks", h)
		}
	}
	for _, h := range []string{"pi", "antigravity"} {
		if harnessSupportsRegistryHooks(h) {
			t.Errorf("%s must not support registry hooks", h)
		}
	}
	if cerr := requireRegistryHookHarnesses([]string{"claude-code", "codex"}, "op"); cerr != nil {
		t.Errorf("supported harnesses must pass: %v", cerr)
	}
	cerr := requireRegistryHookHarnesses([]string{"claude-code", "pi"}, "op")
	if cerr == nil {
		t.Fatal("unsupported harness must fail")
	}
	if !strings.Contains(cerr.Message, "does not support hooks") {
		t.Errorf("message must explain the rejection: %s", cerr.Message)
	}
}

func TestValidateSkillFields(t *testing.T) {
	ok := map[string]any{
		"task_type":           "code-review",
		"version":             "1.0.0",
		"supported_harnesses": []any{"claude-code"},
	}
	if cerr := validateSkillFields(ok, "op"); cerr != nil {
		t.Errorf("valid skill fields rejected: %v", cerr)
	}
	if cerr := validateSkillFields(map[string]any{"task_type": "flying"}, "op"); cerr == nil {
		t.Error("unknown task type must fail")
	}
	if cerr := validateSkillFields(map[string]any{"supported_harnesses": []any{"nope"}}, "op"); cerr == nil {
		t.Error("unknown harness must fail")
	}
	if cerr := validateSkillFields(map[string]any{"version": "bad!!"}, "op"); cerr == nil {
		t.Error("invalid version must fail")
	}
}

func TestValidateHookTimeout(t *testing.T) {
	if cerr := validateHookTimeout(5, "sync"); cerr != nil {
		t.Errorf("within cap must pass: %v", cerr)
	}
	if cerr := validateHookTimeout(100, "unknown-mode"); cerr != nil {
		t.Errorf("unknown mode has no cap: %v", cerr)
	}
	cerr := validateHookTimeout(50, "blocking")
	if cerr == nil {
		t.Fatal("over cap must fail")
	}
	if !strings.Contains(cerr.Message, "30s") {
		t.Errorf("message must mention the cap: %s", cerr.Message)
	}
}

func TestJSONPayloadFile(t *testing.T) {
	if !jsonPayloadFile(map[string]any{"owner": "me"}) {
		t.Error("payload with owner is a JSON payload file")
	}
	if jsonPayloadFile(map[string]any{"name": "x"}) {
		t.Error("payload without owner is not a JSON payload file")
	}
}

func TestReadTextFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	seedFile(t, path, "hello world")
	content, cerr := readTextFile(path, "missing", "op", "remedy")
	if cerr != nil {
		t.Fatalf("existing file rejected: %v", cerr)
	}
	if content != "hello world" {
		t.Errorf("content = %q", content)
	}
	_, cerr = readTextFile(filepath.Join(dir, "absent.txt"), "It is missing.", "op", "remedy")
	if cerr == nil {
		t.Fatal("missing file must fail")
	}
	if cerr.Category != clierr.NotFound {
		t.Errorf("category = %s", cerr.Category)
	}
}

func TestAddPublishTarget(t *testing.T) {
	payload := map[string]any{}
	if cerr := addPublishTarget(payload, "", "registry mcp submit"); cerr != nil {
		t.Fatalf("empty visibility must default: %v", cerr)
	}
	if payload["visibility"] != "project" {
		t.Errorf("default visibility = %v", payload["visibility"])
	}
	if cerr := addPublishTarget(payload, "project", "registry mcp submit"); cerr != nil {
		t.Fatalf("project visibility must pass: %v", cerr)
	}
	if payload["visibility"] != "project" {
		t.Errorf("visibility = %v", payload["visibility"])
	}
	if cerr := addPublishTarget(payload, "private", "registry mcp submit"); cerr != nil || payload["visibility"] != "private" {
		t.Fatalf("private visibility must pass: %v / %v", cerr, payload["visibility"])
	}
	if cerr := addPublishTarget(payload, "public", "registry mcp submit"); cerr == nil {
		t.Error("public visibility must fail")
	}
	if cerr := addPublishTarget(payload, "secret", "registry mcp submit"); cerr == nil {
		t.Error("unknown visibility must fail")
	}
}

func TestDraftSubmitConflict(t *testing.T) {
	cerr := draftSubmitConflict("Submit hook")
	if cerr.Category != clierr.Validation {
		t.Errorf("category = %s", cerr.Category)
	}
	if cerr.Operation != "Submit hook" {
		t.Errorf("operation = %s", cerr.Operation)
	}
}
