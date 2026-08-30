// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// authServer serves the full password-login endpoint set.
func authServer(t *testing.T, signInStatus int, signInBody string) map[string]apiResponse {
	t.Helper()
	return map[string]apiResponse{
		"GET /health":                  {body: `{"status": "ok"}`},
		"GET /api/v1/config/public":    {body: `{}`},
		"POST /api/auth/sign-in/email": {status: signInStatus, body: signInBody},
		"GET /api/auth/tenant-token":   {body: `{"token": "jwt-token-1"}`},
		"GET /api/v1/auth/whoami": {body: `{
			"id": "u1", "email": "x@y.com", "username": "xy", "name": "X Y", "role": "user"
		}`},
		"GET /api/v1/config/endpoints": {body: `{"web": "http://web.example"}`},
	}
}

func TestPasswordLoginPersistsCredentials(t *testing.T) {
	srv := fakeAPI(t, authServer(t, 200, `{"token": "session-token-1"}`))
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CARACAL_PASSWORD", "Str0ng-Passw0rd!")

	out, err := captureCLI(t, "auth", "login", "--server", srv.URL, "--email", "x@y.com", "--no-setup")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Logged in as X Y (x@y.com)") {
		t.Errorf("login output:\n%s", out)
	}

	blob, err := os.ReadFile(home + "/.caracal/config.json")
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(blob, &cfg); err != nil {
		t.Fatalf("config is not JSON: %v", err)
	}
	want := map[string]string{
		"access_token":  "jwt-token-1",
		"session_token": "session-token-1",
		"server_url":    srv.URL,
		"username":      "xy",
		"web_url":       "http://web.example",
	}
	for key, value := range want {
		if cfg[key] != value {
			t.Errorf("config[%s] = %v, want %s", key, cfg[key], value)
		}
	}
	// The password itself must never be persisted.
	if strings.Contains(string(blob), "Passw0rd") {
		t.Error("password leaked into the config file")
	}
}

func TestPasswordLoginRejectedCredentials(t *testing.T) {
	srv := fakeAPI(t, authServer(t, 401, `{"message": "Invalid email or password"}`))
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CARACAL_PASSWORD", "Wrong-Passw0rd!")

	_, err := captureCLI(t, "auth", "login", "--server", srv.URL, "--email", "x@y.com", "--no-setup")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Auth {
		t.Errorf("category = %s", cerr.Category)
	}
	// No credentials may be saved on a failed login.
	if _, statErr := os.Stat(os.Getenv("HOME") + "/.caracal/config.json"); statErr == nil {
		t.Error("failed login persisted a config file")
	}
}

func TestPasswordLoginRejectsTokenlessResponse(t *testing.T) {
	srv := fakeAPI(t, authServer(t, 200, `{"user": {"email": "x@y.com"}}`))
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CARACAL_PASSWORD", "Str0ng-Passw0rd!")

	_, err := captureCLI(t, "auth", "login", "--server", srv.URL, "--email", "x@y.com", "--no-setup")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Unexpected || !strings.Contains(cerr.Message, "invalid login response") {
		t.Errorf("tokenless response: %s %q", cerr.Category, cerr.Message)
	}
}

func TestLogoutClearsCredentials(t *testing.T) {
	routes := authServer(t, 200, `{"token": "session-token-1"}`)
	routes["POST /api/auth/sign-out"] = apiResponse{body: `{}`}
	srv := fakeAPI(t, routes)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CARACAL_PASSWORD", "Str0ng-Passw0rd!")

	if _, err := captureCLI(t, "auth", "login", "--server", srv.URL, "--email", "x@y.com", "--no-setup"); err != nil {
		t.Fatal(err)
	}
	out, err := captureCLI(t, "auth", "logout", "--output", "json")
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		LoggedOut          bool `json:"logged_out"`
		LocalTokensCleared bool `json:"local_tokens_cleared"`
	}
	if jsonErr := json.Unmarshal([]byte(out), &result); jsonErr != nil {
		t.Fatalf("logout output: %v\n%s", jsonErr, out)
	}
	if !result.LoggedOut || !result.LocalTokensCleared {
		t.Errorf("logout result: %+v\n%s", result, out)
	}
	blob, _ := os.ReadFile(home + "/.caracal/config.json")
	for _, banned := range []string{"jwt-token-1", "session-token-1"} {
		if strings.Contains(string(blob), banned) {
			t.Errorf("logout left %s in config:\n%s", banned, blob)
		}
	}
}

func TestValidatePasswordPolicy(t *testing.T) {
	if failed := validatePassword("Str0ng-Passw0rd!"); len(failed) != 0 {
		t.Errorf("valid password rejected: %v", failed)
	}
	cases := []struct {
		password string
		want     string
	}{
		{"Sh0rt!", "At least 12 characters"},
		{"all-lower-cas3-!!", "One uppercase letter"},
		{"No-Digits-Here!!", "One number"},
		{"NoSpecials12345", "One special character"},
	}
	for _, tc := range cases {
		failed := validatePassword(tc.password)
		found := false
		for _, f := range failed {
			if f == tc.want {
				found = true
			}
		}
		if !found {
			t.Errorf("validatePassword(%q) = %v, want %q", tc.password, failed, tc.want)
		}
	}
	// A password failing everything reports every rule.
	if failed := validatePassword("weak"); len(failed) != 4 {
		t.Errorf("weak password failures: %v", failed)
	}
}
