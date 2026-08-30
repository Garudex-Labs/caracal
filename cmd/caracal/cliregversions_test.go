// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

const testPromptID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d"
const testMcpID = "0656308f-8bba-472e-ab77-f96a7ac69fd2"

func TestPromptRenderSubstitutesVariables(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/prompts/" + testPromptID + "/render": {body: `{"rendered": "Hello World!"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "prompt", "render", testPromptID, "--var", "name=World")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out) != "Hello World!" {
		t.Errorf("render output: %q", out)
	}
	req, ok := rec.find("POST", "/api/v1/prompts/"+testPromptID+"/render")
	if !ok || req.Body != `{"variables":{"name":"World"}}` {
		t.Errorf("render body: %q", req.Body)
	}
}

func TestPromptRenderJSONPassesRawThrough(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"POST /api/v1/prompts/" + testPromptID + "/render": {body: `{"rendered": "Hi", "variables_used": ["name"]}`},
	})
	out, err := runCLI(t, srv, "registry", "prompt", "render", testPromptID, "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"variables_used"`) {
		t.Errorf("json render output:\n%s", out)
	}
}

func TestPromptRenderRejectsMalformedVariable(t *testing.T) {
	srv := fakeAPI(t, nil)
	_, err := runCLI(t, srv, "registry", "prompt", "render", testPromptID, "--var", "noequals")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation ||
		!strings.Contains(cerr.Message, "key=value") {
		t.Errorf("bad variable: %s / %s", cerr.Category, cerr.Message)
	}
}

func TestRegistryVersionListPaginates(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/mcps/" + testMcpID + "/versions": {
			body: `{"items": [{"version": "1.2.0", "status": "approved"}], "total": 1}`,
		},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "version", "list", "mcp", testMcpID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "1.2.0") || !strings.Contains(out, "approved") {
		t.Errorf("version list output:\n%s", out)
	}
	req, ok := rec.find("GET", "/api/v1/mcps/"+testMcpID+"/versions")
	if !ok || !strings.Contains(req.Query, "page=1") || !strings.Contains(req.Query, "page_size=50") {
		t.Errorf("version list query: %q", req.Query)
	}
}

func TestRegistryVersionListUnknownTypeRejectedLocally(t *testing.T) {
	_, err := runCLI(t, nil, "registry", "version", "list", "widget", testMcpID)
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "widget") {
		t.Errorf("bad type: %s / %s", cerr.Category, cerr.Message)
	}
	if !strings.Contains(cerr.Remediation, "hook, mcp, prompt, sandbox, skill") {
		t.Errorf("remediation must list types: %s", cerr.Remediation)
	}
}

func TestRegistryVersionPublishPostsVersion(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/mcps/" + testMcpID + "/versions": {body: `{"version": "1.3.0", "status": "pending"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "version", "publish", "mcp", testMcpID, "-d", "fixes", "-v", "1.3.0")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Version 1.3.0 submitted for review!") || !strings.Contains(out, "Status: pending") {
		t.Errorf("publish output:\n%s", out)
	}
	req, ok := rec.find("POST", "/api/v1/mcps/"+testMcpID+"/versions")
	if !ok || req.Body != `{"version":"1.3.0","description":"fixes"}` {
		t.Errorf("publish body: %q", req.Body)
	}
}

func TestRegistryVersionPublishRequiresDescription(t *testing.T) {
	_, err := runCLI(t, nil, "registry", "version", "publish", "mcp", testMcpID, "-v", "1.3.0")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Usage || !strings.Contains(cerr.Message, "--description") {
		t.Errorf("missing description: %s / %s", cerr.Category, cerr.Message)
	}
}

func TestRegistryVersionPublishRejectsInvalidVersion(t *testing.T) {
	srv := fakeAPI(t, nil)
	_, err := runCLI(t, srv, "registry", "version", "publish", "mcp", testMcpID, "-d", "d", "-v", "not.a.version")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || cerr.Message != "The component version is invalid." {
		t.Errorf("bad version: %s / %s", cerr.Category, cerr.Message)
	}
}

func TestRegistryVersionPublishJSONNeedsExplicitVersion(t *testing.T) {
	srv := fakeAPI(t, nil)
	_, err := runCLI(t, srv, "registry", "version", "publish", "mcp", testMcpID, "-d", "d", "-o", "json")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation ||
		cerr.Message != "JSON mode requires an explicit component version." {
		t.Errorf("json publish: %s / %s", cerr.Category, cerr.Message)
	}
}

func TestRegistryVersionPublishRejectsNonObjectExtra(t *testing.T) {
	cases := []struct{ extra, want string }{
		{"not json", "The extra version metadata is not valid JSON."},
		{`["a"]`, "The extra version metadata must be a JSON object."},
	}
	for _, tc := range cases {
		_, err := runCLI(t, nil, "registry", "version", "publish", "mcp", testMcpID,
			"-d", "d", "-v", "1.0.0", "--extra", tc.extra)
		cerr := asCLIError(t, err)
		if cerr.Category != clierr.Validation || cerr.Message != tc.want {
			t.Errorf("extra %q: %s / %s", tc.extra, cerr.Category, cerr.Message)
		}
	}
}
