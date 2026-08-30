// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

const testAgentID = "bb6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d"

func TestAgentVersionsRendersList(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/agents/" + testAgentID + "/versions": {
			body: `{"items": [{"version": "0.2.0", "status": "released"}], "total": 1}`,
		},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "agent", "versions", testAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "0.2.0") || !strings.Contains(out, "released") {
		t.Errorf("agent versions output:\n%s", out)
	}
	req, ok := rec.find("GET", "/api/v1/agents/"+testAgentID+"/versions")
	if !ok || !strings.Contains(req.Query, "page=1") || !strings.Contains(req.Query, "page_size=50") {
		t.Errorf("agent versions query: %q", req.Query)
	}
}

func TestAgentVersionsRejectsBadPagingLocally(t *testing.T) {
	cases := [][]string{
		{"agent", "versions", testAgentID, "--page", "0"},
		{"agent", "versions", testAgentID, "--page-size", "101"},
	}
	for _, args := range cases {
		_, err := runCLI(t, nil, args...)
		cerr := asCLIError(t, err)
		if cerr.Category != clierr.Usage {
			t.Errorf("%v: category = %s", args, cerr.Category)
		}
	}
}
