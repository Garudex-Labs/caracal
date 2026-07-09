// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Internal unit tests for config directory resolution, token sanity checks, path helpers, and heartbeat pacing.

package sdk

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestDefaultConfigDirPrecedence(t *testing.T) {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		t.Skip("linux-specific directory layout")
	}
	t.Setenv("CARACAL_CONFIG_HOME", "/opt/caracal-config")
	t.Setenv("XDG_CONFIG_HOME", "/opt/xdg")
	if got := defaultConfigDir(); got != "/opt/caracal-config" {
		t.Fatalf("config home must win: %q", got)
	}
	t.Setenv("CARACAL_CONFIG_HOME", "")
	if got := defaultConfigDir(); got != filepath.Join("/opt/xdg", "caracal") {
		t.Fatalf("xdg must be honored: %q", got)
	}
	t.Setenv("XDG_CONFIG_HOME", "")
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("no home dir in this environment")
	}
	if got := defaultConfigDir(); got != filepath.Join(home, ".config", "caracal") {
		t.Fatalf("home fallback: %q", got)
	}
	if got := defaultProfilePath(); got != filepath.Join(home, ".config", "caracal", "caracal.toml") {
		t.Fatalf("profile path: %q", got)
	}
}

func TestSafePathSegment(t *testing.T) {
	cases := map[string]string{
		"zone-1":          "zone-1",
		"  app one  ":     "app_one",
		"a//b::c":         "a_b_c",
		"resource://x.y":  "resource_x.y",
		"___":             "default",
		"":                "default",
		"UPPER.lower-9_0": "UPPER.lower-9_0",
	}
	for input, want := range cases {
		if got := safePathSegment(input); got != want {
			t.Fatalf("safePathSegment(%q) = %q, want %q", input, got, want)
		}
	}
}

func jwtWithPayload(t *testing.T, payload string) string {
	t.Helper()
	return "eyJhbGciOiJFUzI1NiJ9." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
}

func TestValidateSubjectTokenShapes(t *testing.T) {
	if err := validateSubjectToken("opaque-token"); err != nil {
		t.Fatalf("opaque tokens are accepted: %v", err)
	}
	if err := validateSubjectToken("a.!!!notbase64!!!.c"); err != nil {
		t.Fatalf("undecodable payloads are accepted: %v", err)
	}
	if err := validateSubjectToken(jwtWithPayload(t, "not json")); err != nil {
		t.Fatalf("non-JSON payloads are accepted: %v", err)
	}
	if err := validateSubjectToken(jwtWithPayload(t, `{"sub":"app"}`)); err != nil {
		t.Fatalf("tokens without exp are accepted: %v", err)
	}
	future := fmt.Sprintf(`{"exp":%d}`, time.Now().Add(time.Hour).Unix())
	if err := validateSubjectToken(jwtWithPayload(t, future)); err != nil {
		t.Fatalf("future exp is accepted: %v", err)
	}
	padded := "eyJhbGciOiJFUzI1NiJ9." + base64.URLEncoding.EncodeToString([]byte(`{"exp":1}`)) + ".sig"
	if err := validateSubjectToken(padded); err == nil {
		t.Fatal("padded-base64 expired tokens are rejected")
	}
}

func TestIsLoopbackHost(t *testing.T) {
	for host, want := range map[string]bool{
		"localhost":   true,
		"127.0.0.1":   true,
		"::1":         true,
		"example.com": false,
		"10.0.0.5":    false,
	} {
		if got := isLoopbackHost(host); got != want {
			t.Fatalf("isLoopbackHost(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestSortBindingsLongestFirstShortInputsUntouched(t *testing.T) {
	if got := sortBindingsLongestFirst(nil); got != nil {
		t.Fatalf("nil input: %#v", got)
	}
	one := []ResourceBinding{{ResourceID: "a", UpstreamPrefix: "https://a.example"}}
	if got := sortBindingsLongestFirst(one); len(got) != 1 || got[0].ResourceID != "a" {
		t.Fatalf("single input: %#v", got)
	}
}

func TestNextDelayModes(t *testing.T) {
	fixed := &SessionHandle{heartbeatInterval: 7 * time.Second}
	if got := fixed.nextDelay(); got != 7*time.Second {
		t.Fatalf("fixed interval: %v", got)
	}
	fallback := &SessionHandle{}
	if got := fallback.nextDelay(); got < 20*time.Second || got > 40*time.Second {
		t.Fatalf("fallback delay out of jitter range: %v", got)
	}
	derived := &SessionHandle{}
	derived.deadlineAt = time.Now().Add(90 * time.Second)
	if got := derived.nextDelay(); got < 20*time.Second || got > 40*time.Second {
		t.Fatalf("derived delay out of range: %v", got)
	}
	clamped := &SessionHandle{}
	clamped.deadlineAt = time.Now().Add(-time.Minute)
	if got := clamped.nextDelay(); got < 500*time.Millisecond || got > 2*time.Second {
		t.Fatalf("past deadline must clamp to the minimum: %v", got)
	}
}
