// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package clierr

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestExitCodesAreStable(t *testing.T) {
	// These codes are the CLI's public failure contract; changing one is a
	// breaking change for every script that checks $?.
	want := map[Category]int{
		Unexpected: 1, Usage: 2, Auth: 3, Permission: 4, NotFound: 5,
		Conflict: 6, Validation: 7, RateLimit: 8, Unavailable: 9, Version: 10,
	}
	for category, code := range want {
		e := &Error{Category: category}
		if got := e.ExitCode(); got != code {
			t.Errorf("%s exit code = %d, want %d", category, got, code)
		}
	}
	if got := (&Error{Category: Category("mystery")}).ExitCode(); got != 1 {
		t.Errorf("unknown category exit code = %d, want 1", got)
	}
}

// captureStderr runs fn with os.Stderr redirected into a pipe.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	defer func() { os.Stderr = old }()
	fn()
	_ = w.Close()
	buf := make([]byte, 1<<16)
	n, _ := r.Read(buf)
	_ = r.Close()
	return string(buf[:n])
}

func TestEmitJSONIsOneParseableDocument(t *testing.T) {
	e := &Error{
		Category: NotFound, Message: "Agent not found.", Operation: "Show agent",
		Resource: "acme/review-bot", Remediation: "List agents first.",
		RequestID: "req-1", HTTPStatus: 404, Detail: "sql: no rows",
	}
	out := captureStderr(t, func() { Emit(e, true, false) })
	if strings.Count(out, "\n") != 1 {
		t.Fatalf("want exactly one line, got %q", out)
	}
	var doc struct {
		Error struct {
			Category    string `json:"category"`
			Message     string `json:"message"`
			Operation   string `json:"operation"`
			ExitCode    int    `json:"exit_code"`
			Resource    string `json:"resource"`
			Remediation string `json:"remediation"`
			RequestID   string `json:"request_id"`
			HTTPStatus  int    `json:"http_status"`
			Detail      string `json:"detail"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	if doc.Error.Category != "not_found" || doc.Error.ExitCode != 5 || doc.Error.HTTPStatus != 404 {
		t.Errorf("document fields: %+v", doc.Error)
	}
	// Detail is debug-only.
	if doc.Error.Detail != "" {
		t.Errorf("detail leaked without debug: %q", doc.Error.Detail)
	}
}

func TestEmitJSONDebugAndOptionalFields(t *testing.T) {
	minimal := &Error{Category: Usage, Message: "Bad flag.", Operation: "Parse args"}
	out := captureStderr(t, func() { Emit(minimal, true, false) })
	for _, absent := range []string{"resource", "remediation", "request_id", "http_status", "detail"} {
		if strings.Contains(out, `"`+absent+`"`) {
			t.Errorf("empty field %q must be omitted: %s", absent, out)
		}
	}

	withDetail := &Error{Category: Usage, Message: "m", Operation: "o", Detail: "stack"}
	out = captureStderr(t, func() { Emit(withDetail, true, true) })
	if !strings.Contains(out, `"detail": "stack"`) {
		t.Errorf("debug mode must include detail: %s", out)
	}
}

func TestEmitJSONDoesNotHTMLEscape(t *testing.T) {
	e := &Error{Category: Validation, Message: "value <x> & \"y\"", Operation: "op"}
	out := captureStderr(t, func() { Emit(e, true, false) })
	if strings.Contains(out, `\u003c`) || strings.Contains(out, `\u0026`) {
		t.Errorf("HTML escaping leaked into the error document: %s", out)
	}
}

func TestEmitHumanBlock(t *testing.T) {
	e := &Error{
		Category: Permission, Message: "Not allowed.", Operation: "Delete team",
		Resource: "acme", Remediation: "Ask an owner.",
	}
	out := captureStderr(t, func() { Emit(e, false, false) })
	for _, line := range []string{
		"Error (permission): Not allowed.",
		"Operation: Delete team",
		"Resource: acme",
		"Remediation: Ask an owner.",
	} {
		if !strings.Contains(out, line+"\n") {
			t.Errorf("human block missing %q:\n%s", line, out)
		}
	}
}
