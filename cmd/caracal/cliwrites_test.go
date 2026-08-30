// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

func TestRegistryInstallFetchesAndPosts(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/mcps/0656308f-8bba-472e-ab77-f96a7ac69fd2": {
			body: `{"id": "0656308f-8bba-472e-ab77-f96a7ac69fd2", "name": "Weather", "status": "approved"}`,
		},
		"POST /api/v1/mcps/0656308f-8bba-472e-ab77-f96a7ac69fd2/install": {
			body: `{"name": "Weather", "harness": "kiro", "installed": true}`,
		},
	})
	out, err := runCLI(t, srv, "registry", "mcp", "install",
		"0656308f-8bba-472e-ab77-f96a7ac69fd2", "--harness", "kiro")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Weather") {
		t.Errorf("install output:\n%s", out)
	}
}

func TestAgentShowRendersDocument(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/agents/0656308f-8bba-472e-ab77-f96a7ac69fd2": {body: `{
			"id": "0656308f-8bba-472e-ab77-f96a7ac69fd2",
			"name": "review-bot", "model_name": "claude-sonnet-4-5",
			"components": [{"type": "mcp", "name": "Weather"}]
		}`},
	})
	out, err := runCLI(t, srv, "agent", "show", "0656308f-8bba-472e-ab77-f96a7ac69fd2")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"review-bot", "claude-sonnet-4-5", "Weather"} {
		if !strings.Contains(out, want) {
			t.Errorf("agent show missing %q:\n%s", want, out)
		}
	}
}
