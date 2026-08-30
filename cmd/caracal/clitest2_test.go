// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

func TestAgentListRendersModelAndNamespace(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/agents": {body: `[
			{"id": "a1", "name": "review-bot", "version": "1.0.0", "model_name": "claude-sonnet-4-5", "namespace": "acme"}
		]`},
	})
	out, err := runCLI(t, srv, "agent", "list")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"review-bot", "claude-sonnet-4-5", "acme"} {
		if !strings.Contains(out, want) {
			t.Errorf("agent list missing %q:\n%s", want, out)
		}
	}
}

func TestAgentListEmptyMessage(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/agents": {body: `[]`},
	})
	out, err := runCLI(t, srv, "agent", "list")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "No agents found") {
		t.Errorf("empty message missing:\n%s", out)
	}
}

func TestAuthWhoamiRendersIdentity(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/auth/whoami": {body: `{
			"id": "0656308f-8bba-472e-ab77-f96a7ac69fd2",
			"username": "rawx18", "email": "raw@example.com", "role": "super_admin"
		}`},
	})
	out, err := runCLI(t, srv, "auth", "whoami")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"rawx18", "raw@example.com", "super_admin"} {
		if !strings.Contains(out, want) {
			t.Errorf("whoami missing %q:\n%s", want, out)
		}
	}
}

func TestAuthStatusReportsServerHealth(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /health": {body: `{"status": "ok"}`},
	})
	out, err := runCLI(t, srv, "auth", "status")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "reachable") {
		t.Errorf("status must report reachability:\n%s", out)
	}
	if !strings.Contains(out, srv.URL) {
		t.Errorf("status must name the server:\n%s", out)
	}
}

func TestOpsTelemetryStatus(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/telemetry/status": {body: `{
			"sessions_24h": 42, "events_24h": 1200, "last_ingest_at": "2026-08-30T09:00:00Z"
		}`},
	})
	out, err := runCLI(t, srv, "ops", "telemetry", "status")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "42") {
		t.Errorf("telemetry status output:\n%s", out)
	}
}

func TestRegistryModelsListWorksOffline(t *testing.T) {
	// Model data is embedded registry content; no server may be contacted.
	out, err := runCLI(t, nil, "registry", "models", "list")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "exact") || !strings.Contains(out, "alias") {
		t.Errorf("models list output:\n%s", out)
	}
}

func TestRegistryRecommend(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/recommendations/me": {body: `{"items": [
			{"type": "mcp", "name": "Weather", "namespace": "acme", "slug": "weather", "reason": "used in 3 sessions"}
		]}`},
	})
	out, err := runCLI(t, srv, "registry", "recommend")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Weather") {
		t.Errorf("recommend output:\n%s", out)
	}
}

func TestConfigShowAndSetRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	root := newRootCommand()
	root.SetArgs([]string{"config", "set", "timeout", "45"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	out, err := runCLIKeepHome(t, "config", "show")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "45") {
		t.Errorf("config show must reflect the set value:\n%s", out)
	}
}

// runCLIKeepHome runs a command without resetting HOME, for multi-step flows.
func runCLIKeepHome(t *testing.T, args ...string) (string, error) {
	t.Helper()
	return captureCLI(t, args...)
}
