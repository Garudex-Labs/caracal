// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// reconcileDoc mirrors the reconcile JSON contract for assertions.
type reconcileDoc struct {
	DryRun        bool  `json:"dry_run"`
	SinceHours    int   `json:"since_hours"`
	OutboxDrained *bool `json:"outbox_drained"`
	Targets       []struct {
		Harness  string `json:"harness"`
		Sessions []struct {
			SessionID  string `json:"session_id"`
			Status     string `json:"status"`
			BytesNew   int64  `json:"bytes_new"`
			HTTPStatus int    `json:"http_status"`
		} `json:"sessions"`
	} `json:"targets"`
	Summary struct {
		Discovered    int `json:"discovered"`
		Pushed        int `json:"pushed"`
		Queued        int `json:"queued"`
		Rejected      int `json:"rejected"`
		WouldPush     int `json:"would_push"`
		WouldFinalize int `json:"would_finalize"`
		UpToDate      int `json:"up_to_date"`
		Errors        int `json:"errors"`
	} `json:"summary"`
	Rejections []struct {
		Harness    string `json:"harness"`
		SessionID  string `json:"session_id"`
		HTTPStatus int    `json:"http_status"`
	} `json:"rejections"`
}

func parseReconcile(t *testing.T, out string) reconcileDoc {
	t.Helper()
	var doc reconcileDoc
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("reconcile output is not JSON: %v\n%s", err, out)
	}
	return doc
}

// seedDeliveryConfig writes the session delivery credentials reconcile reads.
func seedDeliveryConfig(t *testing.T, home, serverURL string) {
	t.Helper()
	seedFile(t, filepath.Join(home, ".caracal", "config.json"),
		fmt.Sprintf(`{"server_url": %q, "access_token": "tok", "user_id": "u1", "default_org": "acme", "default_project": "platform"}`, serverURL))
}

func TestReconcileDryRunPreviewsWithoutNetwork(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// No reachable server: dry-run must not need one.
	seedDeliveryConfig(t, home, "http://127.0.0.1:1")
	transcript := "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n"
	seedFile(t, filepath.Join(home, ".claude", "projects", "-home-u-proj", "sess-1.jsonl"), transcript)

	out, err := captureCLI(t, "reconcile", "--dry-run")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Would push: sess-1") ||
		!strings.Contains(out, "Dry run: 1 session(s) would send records; 0 would send final metadata.") {
		t.Errorf("dry-run table output:\n%s", out)
	}

	out, err = captureCLI(t, "reconcile", "--dry-run", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	doc := parseReconcile(t, out)
	if !doc.DryRun || doc.SinceHours != 168 || doc.OutboxDrained != nil {
		t.Errorf("dry-run envelope: %+v", doc)
	}
	if doc.Summary.Discovered != 1 || doc.Summary.WouldPush != 1 || doc.Summary.Pushed != 0 {
		t.Errorf("dry-run summary: %+v", doc.Summary)
	}
	if len(doc.Targets) != 1 || doc.Targets[0].Harness != "claude-code" {
		t.Fatalf("dry-run targets: %+v", doc.Targets)
	}
	session := doc.Targets[0].Sessions[0]
	if session.SessionID != "sess-1" || session.Status != "would_push" || session.BytesNew != int64(len(transcript)) {
		t.Errorf("dry-run session entry: %+v", session)
	}
}

func TestReconcilePushDeliversThenReportsUpToDate(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		// Second line index is 1: acknowledging it accepts the whole batch.
		"POST /api/v1/ingest/session": {body: `{"acknowledged_line": 1}`},
	})
	home := t.TempDir()
	t.Setenv("HOME", home)
	seedDeliveryConfig(t, home, rec.srv.URL)
	seedFile(t, filepath.Join(home, ".claude", "projects", "-home-u-proj", "sess-1.jsonl"),
		"{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n")

	out, err := captureCLI(t, "reconcile", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	doc := parseReconcile(t, out)
	if doc.Summary.Pushed != 1 || doc.Summary.Queued != 0 || doc.Summary.Rejected != 0 {
		t.Errorf("push summary: %+v", doc.Summary)
	}
	if doc.OutboxDrained == nil || !*doc.OutboxDrained {
		t.Errorf("outbox_drained: %+v", doc.OutboxDrained)
	}
	if doc.Targets[0].Sessions[0].Status != "pushed" {
		t.Errorf("session status: %+v", doc.Targets[0].Sessions[0])
	}

	// The delivery consults the server checkpoint, then posts the batch.
	checkpoint, ok := rec.find("GET", "/api/v1/ingest/session/checkpoint")
	if !ok || !strings.Contains(checkpoint.Query, "harness=claude-code") ||
		!strings.Contains(checkpoint.Query, "session_id=sess-1") {
		t.Errorf("checkpoint request: %+v (%v)", checkpoint, rec.lines())
	}
	ingest, ok := rec.find("POST", "/api/v1/ingest/session")
	if !ok {
		t.Fatalf("no ingest request: %v", rec.lines())
	}
	for _, want := range []string{
		`"session_id":"sess-1"`, `"harness":"claude-code"`, `"hook_event":"Reconcile"`,
		`"final":true`, `"total_line_count":2`, `{\"type\":\"user\"}`,
	} {
		if !strings.Contains(ingest.Body, want) {
			t.Errorf("ingest body missing %s:\n%s", want, ingest.Body)
		}
	}

	// A second run finds the finalized cursor and delivers nothing.
	out, err = captureCLI(t, "reconcile", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	doc = parseReconcile(t, out)
	if doc.Summary.UpToDate != 1 || doc.Summary.Pushed != 0 {
		t.Errorf("second-run summary: %+v", doc.Summary)
	}
	out, err = captureCLI(t, "reconcile")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "No new sessions to deliver.") {
		t.Errorf("second-run table output:\n%s", out)
	}
}

func TestReconcileRejectedBatchIsQuarantined(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/ingest/session": {status: 422, body: `{"detail": "bad payload"}`},
	})
	home := t.TempDir()
	t.Setenv("HOME", home)
	seedDeliveryConfig(t, home, rec.srv.URL)
	seedFile(t, filepath.Join(home, ".claude", "projects", "-home-u-proj", "sess-1.jsonl"),
		"{\"type\":\"user\"}\n")

	// Rejections warn but do not fail the command.
	out, err := captureCLI(t, "reconcile", "--harness", "claude-code", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	doc := parseReconcile(t, out)
	if doc.Summary.Rejected != 1 || doc.Summary.Pushed != 0 {
		t.Errorf("rejected summary: %+v", doc.Summary)
	}
	session := doc.Targets[0].Sessions[0]
	if session.Status != "rejected" || session.HTTPStatus != 422 {
		t.Errorf("rejected session entry: %+v", session)
	}
	if len(doc.Rejections) != 1 || doc.Rejections[0].SessionID != "sess-1" ||
		doc.Rejections[0].HTTPStatus != 422 {
		t.Errorf("rejections rows: %+v", doc.Rejections)
	}
}

func TestReconcileServerFailureQueuesForRetry(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/ingest/session": {status: 500, body: `{}`},
	})
	home := t.TempDir()
	t.Setenv("HOME", home)
	seedDeliveryConfig(t, home, rec.srv.URL)
	seedFile(t, filepath.Join(home, ".claude", "projects", "-home-u-proj", "sess-1.jsonl"),
		"{\"type\":\"user\"}\n")

	out, err := captureCLI(t, "reconcile", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	doc := parseReconcile(t, out)
	if doc.Summary.Queued != 1 || doc.Summary.Rejected != 0 || doc.Summary.Errors != 0 {
		t.Errorf("queued summary: %+v", doc.Summary)
	}
	if doc.Targets[0].Sessions[0].Status != "queued" {
		t.Errorf("session status: %+v", doc.Targets[0].Sessions[0])
	}
}

func TestReconcileWithoutDeliveryConfigIsAuthError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "reconcile")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Auth {
		t.Errorf("category = %s", cerr.Category)
	}
	if !strings.Contains(cerr.Remediation, "caracal auth login") {
		t.Errorf("remediation must point at login: %s", cerr.Remediation)
	}
}

func TestReconcileUnknownHarnessListsChoices(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	seedDeliveryConfig(t, home, "http://127.0.0.1:1")
	_, err := captureCLI(t, "reconcile", "--harness", "vibecoder")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "vibecoder") {
		t.Errorf("unknown harness: %s / %s", cerr.Category, cerr.Message)
	}
	for _, name := range []string{"claude-code", "kiro", "cursor", "codex"} {
		if !strings.Contains(cerr.Remediation, name) {
			t.Errorf("remediation must list %s: %s", name, cerr.Remediation)
		}
	}
}

func TestReconcileSinceRangeIsUsageError(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	seedDeliveryConfig(t, home, "http://127.0.0.1:1")
	for _, since := range []string{"0", "8761"} {
		_, err := captureCLI(t, "reconcile", "--since", since)
		cerr := asCLIError(t, err)
		if cerr.Category != clierr.Usage || !strings.Contains(cerr.Message, since) {
			t.Errorf("--since %s: %s / %s", since, cerr.Category, cerr.Message)
		}
	}
}

func TestReconcileNoInstalledHarnesses(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	seedDeliveryConfig(t, home, "http://127.0.0.1:1")
	out, err := captureCLI(t, "reconcile")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "No installed harnesses were detected.") {
		t.Errorf("empty-home output:\n%s", out)
	}
}
