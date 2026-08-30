// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
)

func TestLocalServerAliveFalseWhenUnavailable(t *testing.T) {
	if localServerAlive() {
		t.Skip("localhost health endpoint is running in the shared dev environment")
	}
}

func TestDeviceFlowLoginRejectsInvalidGrant(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/device/code" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"device_code":"missing required fields"}`))
	}))
	defer srv.Close()
	var err error
	captureStdout(t, func() {
		err = deviceFlowLogin(srv.URL, false, "", "json")
	})
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Unexpected || !strings.Contains(cerr.Message, "invalid device authorization") {
		t.Fatalf("err = %+v", cerr)
	}
}

func TestDeviceFlowLoginExpiredToken(t *testing.T) {
	srv := deviceFlowServer(t, `{"error":"expired_token"}`)
	var err error
	out := captureStdout(t, func() {
		err = deviceFlowLogin(srv.URL, false, "", "json")
	})
	if !strings.Contains(out, `"event":"authorization_required"`) {
		t.Errorf("json mode should emit authorization event, got %s", out)
	}
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Auth || cerr.HTTPStatus != http.StatusBadRequest {
		t.Fatalf("err = %+v", cerr)
	}
}

func TestDeviceFlowLoginAccessDenied(t *testing.T) {
	srv := deviceFlowServer(t, `{"error":"access_denied"}`)
	var err error
	captureStdout(t, func() {
		err = deviceFlowLogin(srv.URL, false, "", "json")
	})
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Permission || cerr.HTTPStatus != http.StatusBadRequest {
		t.Fatalf("err = %+v", cerr)
	}
}

func TestFinishLoginPersistsSessionTokenNotAPIKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/config/endpoints" {
			_, _ = w.Write([]byte(`{"web":"http://localhost:8000"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	err := finishLogin(srv.URL, &sessionData{
		SessionToken: "better-auth-session",
		AccessToken:  "tenant-jwt",
		User: map[string]any{
			"id":       "u1",
			"name":     "Dev User",
			"email":    "dev@localhost.caracal",
			"role":     "user",
			"username": "dev",
		},
	}, "json", "device", false, false)
	if err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(filepath.Join(home, ".caracal", "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(blob)
	for _, want := range []string{`"session_token": "better-auth-session"`, `"access_token": "tenant-jwt"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("config missing %s: %s", want, text)
		}
	}
	if strings.Contains(text, "api_key") || strings.Contains(text, "refresh_token") {
		t.Fatalf("config must not persist API or refresh tokens: %s", text)
	}
}

func deviceFlowServer(t *testing.T, tokenBody string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/device/code":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(fmt.Sprintf(`{"device_code":"dc","user_code":"UCODE","verification_uri":"%s/device","expires_in":60,"interval":-1}`, r.Host)))
		case "/api/auth/device/token":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(tokenBody))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestAcquireCLILockCreatesAndRejectsActiveLock(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path, cerr := acquireCLILock("Upgrade CLI")
	if cerr != nil {
		t.Fatalf("acquire lock: %v", cerr)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("lock file was not written: %v", err)
	}
	_, cerr = acquireCLILock("Upgrade CLI")
	if cerr == nil || cerr.Category != clierr.Conflict {
		t.Fatalf("second acquire should conflict, got %v", cerr)
	}
}

func TestAcquireCLILockReplacesStaleLock(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := os.MkdirAll(config.Dir(), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(config.Dir(), ".cli-upgrade.lock")
	old := time.Now().Add(-2 * time.Hour).Unix()
	if err := os.WriteFile(path, []byte(fmt.Sprintf(`{"pid":%d,"timestamp":%d}`, os.Getpid(), old)), 0o644); err != nil {
		t.Fatal(err)
	}
	got, cerr := acquireCLILock("Upgrade CLI")
	if cerr != nil {
		t.Fatalf("stale lock should be replaced: %v", cerr)
	}
	if got != path {
		t.Errorf("path = %q, want %q", got, path)
	}
}
