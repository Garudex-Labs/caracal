// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestFormatRemoteLogRendersTimestampSlice(t *testing.T) {
	entry := newOmap()
	entry.set("timestamp", "2026-08-30T10:00:00.123Z")
	entry.set("level", "INFO")
	entry.set("logger_name", "boot")
	entry.set("function", "main")
	entry.set("line", 1)
	entry.set("event", "started")
	got := formatRemoteLog(entry)
	for _, want := range []string{"10:00:00.123", "INFO", "boot:main:1", "started"} {
		if !strings.Contains(got, want) {
			t.Errorf("formatRemoteLog missing %q: %q", want, got)
		}
	}
}

func TestOpsLogsRemoteZeroLinesIsNoop(t *testing.T) {
	// A zero recent-line request returns before any server contact.
	t.Setenv("HOME", t.TempDir())
	out, err := captureCLI(t, "ops", "logs", "--remote", "--no-follow", "--lines", "0")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out) != "" {
		t.Errorf("zero-line remote read must print nothing:\n%s", out)
	}
}

func TestOpsLogsRemoteTextRendersEntries(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/operator/logs": {body: `{"entries": [{"timestamp": "2026-08-30T10:00:00.000Z", "level": "INFO", "logger_name": "boot", "function": "main", "line": 1, "event": "started"}]}`},
	})
	// Text mode writes to stderr; success is the contract we assert here.
	if _, err := runCLI(t, srv, "ops", "logs", "--remote", "--no-follow", "--lines", "3"); err != nil {
		t.Fatal(err)
	}
}

func TestOpsLogsRemoteInvalidResponseIsUnavailable(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/operator/logs": {body: `{"unexpected": true}`},
	})
	_, err := runCLI(t, srv, "ops", "logs", "--remote", "--no-follow", "--lines", "3")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Unavailable || !strings.Contains(cerr.Message, "invalid recent logs") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestOpsLogsRejectsNegativeLinesLocally(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "ops", "logs", "--lines", "-1")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Usage || !strings.Contains(cerr.Message, "--lines") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}
