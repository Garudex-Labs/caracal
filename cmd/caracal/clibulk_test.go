// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func writeBulk(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "bulk.json")
	seedFile(t, path, body)
	return path
}

func TestLoadBulkComponentsValid(t *testing.T) {
	path := writeBulk(t, `[
		{"type": "mcp", "name": "Weather", "command": "npx"},
		{"type": "skill", "name": "Reviewer", "version": "2.1.0"}
	]`)
	components, cerr := loadBulkComponents(path)
	if cerr != nil {
		t.Fatalf("valid file rejected: %v", cerr)
	}
	if len(components) != 2 {
		t.Fatalf("want 2 components, got %d", len(components))
	}
	// Missing version defaults to 1.0.0; provided version is preserved.
	if components[0].Payload["version"] != "1.0.0" {
		t.Errorf("default version = %v", components[0].Payload["version"])
	}
	if components[1].Payload["version"] != "2.1.0" {
		t.Errorf("explicit version = %v", components[1].Payload["version"])
	}
	// The type key is stripped from the payload.
	if _, has := components[0].Payload["type"]; has {
		t.Error("type must not remain in payload")
	}
}

func TestLoadBulkComponentsWrapper(t *testing.T) {
	path := writeBulk(t, `{"components": [{"type": "hook", "name": "Guard"}]}`)
	components, cerr := loadBulkComponents(path)
	if cerr != nil {
		t.Fatalf("wrapper form rejected: %v", cerr)
	}
	if len(components) != 1 || components[0].Type != "hook" {
		t.Errorf("wrapper parse wrong: %v", components)
	}
}

func TestLoadBulkComponentsErrors(t *testing.T) {
	cases := []struct {
		name string
		body string
		cat  clierr.Category
	}{
		{"invalidJSON", `{not json`, clierr.Validation},
		{"emptyArray", `[]`, clierr.Validation},
		{"scalarEntry", `[1, 2]`, clierr.Validation},
		{"unknownType", `[{"type": "widget", "name": "x"}]`, clierr.Validation},
		{"missingName", `[{"type": "mcp"}]`, clierr.Validation},
		{"duplicate", `[{"type":"mcp","name":"A"},{"type":"mcp","name":"a"}]`, clierr.Validation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeBulk(t, tc.body)
			_, cerr := loadBulkComponents(path)
			if cerr == nil {
				t.Fatal("expected an error")
			}
			if cerr.Category != tc.cat {
				t.Errorf("category = %s, want %s", cerr.Category, tc.cat)
			}
		})
	}
}

func TestLoadBulkComponentsMissingFile(t *testing.T) {
	_, cerr := loadBulkComponents(filepath.Join(t.TempDir(), "absent.json"))
	if cerr == nil {
		t.Fatal("missing file must fail")
	}
	if cerr.Category != clierr.NotFound {
		t.Errorf("category = %s", cerr.Category)
	}
}

func TestLoadBulkComponentsTooMany(t *testing.T) {
	var parts []string
	for i := 0; i < 201; i++ {
		parts = append(parts, `{"type":"mcp","name":"srv`+itoa(i)+`"}`)
	}
	path := writeBulk(t, "["+strings.Join(parts, ",")+"]")
	_, cerr := loadBulkComponents(path)
	if cerr == nil || !strings.Contains(cerr.Message, "200") {
		t.Errorf("over-200 entries must fail with a 200 cap message: %v", cerr)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}

func TestRawField(t *testing.T) {
	doc := map[string]json.RawMessage{"id": json.RawMessage(`"abc"`)}
	if rawField(doc, "id") != `"abc"` {
		t.Errorf("present field = %q", rawField(doc, "id"))
	}
	if rawField(doc, "missing") != "null" {
		t.Errorf("absent field must be null, got %q", rawField(doc, "missing"))
	}
}

func TestBulkSubmitDryRun(t *testing.T) {
	path := writeBulk(t, `[{"type":"mcp","name":"Weather"},{"type":"skill","name":"Reviewer"}]`)
	out, err := runCLI(t, nil, "registry", "bulk", "submit", "--from-file", path, "--dry-run")
	if err != nil {
		t.Fatalf("dry run failed: %v", err)
	}
	if !strings.Contains(out, "Weather") || !strings.Contains(out, "planned") {
		t.Errorf("dry-run table missing rows:\n%s", out)
	}
}

func TestBulkSubmitDryRunJSON(t *testing.T) {
	path := writeBulk(t, `[{"type":"mcp","name":"Weather"}]`)
	out, err := runCLI(t, nil, "registry", "bulk", "submit", "--from-file", path, "--dry-run", "-o", "json")
	if err != nil {
		t.Fatalf("dry run json failed: %v", err)
	}
	var doc struct {
		Total  int  `json:"total"`
		DryRun bool `json:"dry_run"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	if doc.Total != 1 || !doc.DryRun {
		t.Errorf("unexpected dry-run doc: %+v", doc)
	}
}

func TestBulkSubmitJSONRequiresYes(t *testing.T) {
	path := writeBulk(t, `[{"type":"mcp","name":"Weather"}]`)
	_, err := runCLI(t, nil, "registry", "bulk", "submit", "--from-file", path, "-o", "json")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation {
		t.Errorf("category = %s", cerr.Category)
	}
}

func TestBulkSubmitMissingFileFlag(t *testing.T) {
	_, err := runCLI(t, nil, "registry", "bulk", "submit")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Usage {
		t.Errorf("category = %s", cerr.Category)
	}
}

func TestBulkSubmitSuccessFlow(t *testing.T) {
	path := writeBulk(t, `[
		{"type":"mcp","name":"Weather","owner":"me","command":"npx"},
		{"type":"skill","name":"Reviewer","owner":"me"}
	]`)
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/mcps/submit":   {body: `{"id": "m1", "qualified_name": "me/weather", "status": "pending"}`},
		"POST /api/v1/skills/submit": {body: `{"id": "s1", "qualified_name": "me/reviewer", "status": "pending"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "bulk", "submit", "--from-file", path, "--yes", "-o", "json")
	if err != nil {
		t.Fatalf("submit failed: %v", err)
	}
	var doc struct {
		Total     int `json:"total"`
		Submitted int `json:"submitted"`
		Errors    int `json:"errors"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	if doc.Total != 2 || doc.Submitted != 2 || doc.Errors != 0 {
		t.Errorf("unexpected result doc: %+v", doc)
	}
	if _, ok := rec.find("POST", "/api/v1/mcps/submit"); !ok {
		t.Error("mcp submit not recorded")
	}
	if _, ok := rec.find("POST", "/api/v1/skills/submit"); !ok {
		t.Error("skill submit not recorded")
	}
}

func TestBulkSubmitConflictSkips(t *testing.T) {
	path := writeBulk(t, `[{"type":"mcp","name":"Weather","owner":"me"}]`)
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/mcps/submit": {status: 409, body: `{"detail": "already exists"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "bulk", "submit", "--from-file", path, "--yes", "-o", "json")
	if err != nil {
		t.Fatalf("submit failed: %v", err)
	}
	var doc struct {
		Skipped int `json:"skipped"`
		Errors  int `json:"errors"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	if doc.Skipped != 1 || doc.Errors != 0 {
		t.Errorf("conflict must skip, not error: %+v", doc)
	}
}
