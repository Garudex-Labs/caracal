// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// ── auth set-username ──────────────────────────────────────────────

func TestSetUsernameRejectsInvalidNamespaceLocally(t *testing.T) {
	_, err := runCLI(t, nil, "auth", "set-username", "BadName")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "Namespaces must be") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestSetUsernamePutsProfileAndPersists(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"PUT /api/v1/auth/profile/username": {body: `{"username": "rawx18"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "auth", "set-username", "rawx18", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	req, ok := rec.find("PUT", "/api/v1/auth/profile/username")
	if !ok {
		t.Fatalf("profile endpoint not called: %v", rec.lines())
	}
	if !strings.Contains(req.Body, `"username":"rawx18"`) {
		t.Errorf("request body = %s", req.Body)
	}
	var doc map[string]any
	if json.Unmarshal([]byte(out), &doc) != nil || doc["username"] != "rawx18" {
		t.Errorf("response passthrough:\n%s", out)
	}
	// The effective username is cached locally for later commands.
	shown, err := captureCLI(t, "config", "show", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if json.Unmarshal([]byte(shown), &cfg) != nil || cfg["username"] != "rawx18" {
		t.Errorf("username must persist to config:\n%s", shown)
	}
}

func TestSetUsernameSurfacesServerConflict(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"PUT /api/v1/auth/profile/username": {status: 409, body: `{"detail": "username already taken"}`},
	})
	_, err := runCLI(t, srv, "auth", "set-username", "rawx18")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Conflict || !strings.Contains(cerr.Message, "already taken") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

// ── auth change-password ───────────────────────────────────────────

func TestChangePasswordWithoutSessionIsAuthError(t *testing.T) {
	// No server env: config has neither server_url nor access_token, so the
	// command must fail with the auth contract before any network activity.
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "auth", "change-password")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Auth || !strings.Contains(cerr.Message, "authenticated session") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
	if !strings.Contains(cerr.Remediation, "auth login") {
		t.Errorf("remediation must point at login: %s", cerr.Remediation)
	}
}

func TestChangePasswordJSONModeRequiresSecrets(t *testing.T) {
	// An authenticated session is present via env, but JSON mode never prompts
	// and no password secrets are supplied.
	srv := fakeAPI(t, nil)
	_, err := runCLI(t, srv, "auth", "change-password", "-o", "json")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "requires current and new password") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
	if !strings.Contains(cerr.Remediation, "CARACAL_CURRENT_PASSWORD") {
		t.Errorf("remediation must name the secrets: %s", cerr.Remediation)
	}
}
