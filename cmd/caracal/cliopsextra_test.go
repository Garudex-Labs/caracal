// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// ── ops top ────────────────────────────────────────────────────────

func TestOpsTopMCPsHitsMCPRanking(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/overview/top-mcps": {body: `[{"name": "Weather", "installs": 9}]`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "ops", "top", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := rec.find("GET", "/api/v1/overview/top-mcps"); !ok {
		t.Fatalf("mcp ranking endpoint not called: %v", rec.lines())
	}
	var doc struct {
		Items []map[string]any `json:"items"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil || len(doc.Items) != 1 || doc.Items[0]["name"] != "Weather" {
		t.Errorf("top mcp rows:\n%s", out)
	}
}

func TestOpsTopAgentsHitsAgentRanking(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/overview/top-agents": {body: `[{"name": "review-bot", "installs": 4}]`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "ops", "top", "--type", "agent")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := rec.find("GET", "/api/v1/overview/top-agents"); !ok {
		t.Fatalf("agent ranking endpoint not called: %v", rec.lines())
	}
	if !strings.Contains(out, "review-bot") {
		t.Errorf("top agents output:\n%s", out)
	}
}

func TestOpsTopRejectsUnknownTypeLocally(t *testing.T) {
	_, err := runCLI(t, nil, "ops", "top", "--type", "prompt")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "prompt") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
	if !strings.Contains(cerr.Remediation, "mcp") || !strings.Contains(cerr.Remediation, "agent") {
		t.Errorf("remediation must list ranking types: %s", cerr.Remediation)
	}
}

// ── ops traces ─────────────────────────────────────────────────────

func TestOpsTracesForwardsFiltersAndRendersEnvelope(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/sessions": {body: `[{"session_id": "s1", "platform": "kiro"}]`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "ops", "traces", "--platform", "kiro", "--days", "7", "--limit", "5", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	req, ok := rec.find("GET", "/api/v1/sessions")
	if !ok {
		t.Fatalf("sessions endpoint not called: %v", rec.lines())
	}
	for _, want := range []string{"limit=5", "platform=kiro", "days=7"} {
		if !strings.Contains(req.Query, want) {
			t.Errorf("query %q missing in %s", want, req.Query)
		}
	}
	var doc struct {
		Items []map[string]any `json:"items"`
		Total int              `json:"total"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil || doc.Total != 1 {
		t.Errorf("traces envelope:\n%s", out)
	}
}

func TestOpsTracesTurnViewUnfoldsSessionDetail(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/sessions":    {body: `[{"session_id": "s1"}]`},
		"GET /api/v1/sessions/s1": {body: `{"session_id": "s1", "turns": [{"prompt": "hi"}]}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "ops", "traces", "--turn", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := rec.find("GET", "/api/v1/sessions/s1"); !ok {
		t.Fatalf("turn view must fetch per-session detail: %v", rec.lines())
	}
	var doc struct {
		View  string `json:"view"`
		Items []struct {
			Detail map[string]any `json:"detail"`
		} `json:"items"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil || doc.View != "turn" {
		t.Fatalf("turn view document:\n%s", out)
	}
	if len(doc.Items) != 1 || doc.Items[0].Detail["session_id"] != "s1" {
		t.Errorf("turn detail missing:\n%s", out)
	}
}

func TestOpsTracesSpanViewIsLabelled(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/sessions":    {body: `[{"session_id": "s1"}]`},
		"GET /api/v1/sessions/s1": {body: `{"session_id": "s1"}`},
	})
	out, err := runCLI(t, srv, "ops", "traces", "--span", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		View string `json:"view"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil || doc.View != "span" {
		t.Errorf("span view document:\n%s", out)
	}
}

func TestOpsTracesRejectsOutOfRangeDaysLocally(t *testing.T) {
	_, err := runCLI(t, nil, "ops", "traces", "--days", "400")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Usage || !strings.Contains(cerr.Message, "--days") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestOpsTracesRejectsOutOfRangeLimitLocally(t *testing.T) {
	_, err := runCLI(t, nil, "ops", "traces", "--limit", "0")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Usage || !strings.Contains(cerr.Message, "--limit") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestOpsTracesRejectsUnknownPlatformLocally(t *testing.T) {
	_, err := runCLI(t, nil, "ops", "traces", "--platform", "notaharness")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "notaharness") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

// ── ops telemetry status (JSON) ────────────────────────────────────

func TestOpsTelemetryStatusJSONMergesServerAndOutbox(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/telemetry/status": {body: `{"sessions_24h": 42, "events_24h": 1200}`},
	})
	out, err := runCLI(t, srv, "ops", "telemetry", "status", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Server map[string]any `json:"server"`
		Outbox map[string]any `json:"outbox"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("status is not JSON:\n%s", out)
	}
	if doc.Server["sessions_24h"] != float64(42) {
		t.Errorf("server block missing telemetry: %v", doc.Server)
	}
	if _, ok := doc.Outbox["available"]; !ok {
		t.Errorf("outbox block must report availability: %v", doc.Outbox)
	}
}
