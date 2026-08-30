// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

// The sandbox runtime entrypoints are stdio/exec bridges. Only the argument
// decoding that fails before any runtime work is safe to drive in-process.

func TestSandboxMCPRejectsMalformedSpecJSON(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "sandbox", "mcp", "--sandboxes", "{not json")
	if err == nil || !strings.Contains(err.Error(), "invalid --sandboxes JSON") {
		t.Errorf("malformed sandbox specs must be rejected: %v", err)
	}
}

func TestSandboxRunRejectsMalformedResourceLimits(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "sandbox", "run",
		"--sandbox-id", "s1", "--image", "alpine", "--resource-limits", "{bad")
	if err == nil || !strings.Contains(err.Error(), "invalid --resource-limits JSON") {
		t.Errorf("malformed resource limits must be rejected: %v", err)
	}
}

func TestSandboxRunRejectsMalformedRuntimeConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "sandbox", "run",
		"--sandbox-id", "s1", "--image", "alpine", "--runtime-config", "{bad")
	if err == nil || !strings.Contains(err.Error(), "invalid --runtime-config JSON") {
		t.Errorf("malformed runtime config must be rejected: %v", err)
	}
}

func TestCutEnvPairSplitsAndTrimsQuotes(t *testing.T) {
	cases := []struct {
		in                 string
		wantKey, wantValue string
		wantOK             bool
	}{
		{"KEY=value", "KEY", "value", true},
		{`TOKEN="quoted"`, "TOKEN", "quoted", true},
		{"EMPTY=", "EMPTY", "", true},
		{"novalue", "novalue", "", false},
		{"PATH=/usr/bin=extra", "PATH", "/usr/bin=extra", true},
	}
	for _, tc := range cases {
		key, value, ok := cutEnvPair(tc.in)
		if key != tc.wantKey || value != tc.wantValue || ok != tc.wantOK {
			t.Errorf("cutEnvPair(%q) = (%q, %q, %v), want (%q, %q, %v)",
				tc.in, key, value, ok, tc.wantKey, tc.wantValue, tc.wantOK)
		}
	}
}

func TestTrimQuotesStripsMatchingWrappers(t *testing.T) {
	cases := map[string]string{
		`"double"`:   "double",
		`'single'`:   "single",
		`bare`:       "bare",
		`"unbalced`:  "unbalced",
		`''nested''`: "nested",
	}
	for in, want := range cases {
		if got := trimQuotes(in); got != want {
			t.Errorf("trimQuotes(%q) = %q, want %q", in, got, want)
		}
	}
}
