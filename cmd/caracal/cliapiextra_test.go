// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAPICommandForwardsPatchWithBody(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"PATCH /api/v1/widgets/w-1": {body: `{"id": "w-1", "state": "paused"}`},
	})
	home := recEnv(t, rec)
	bodyFile := filepath.Join(home, "patch.json")
	if err := os.WriteFile(bodyFile, []byte(`{"state": "paused"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := captureCLI(t, "api", "patch", "/api/v1/widgets/w-1", "-f", bodyFile, "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	req, ok := rec.find("PATCH", "/api/v1/widgets/w-1")
	if !ok {
		t.Fatalf("PATCH never reached the server: %v", rec.lines())
	}
	if !strings.Contains(req.Body, `"state":"paused"`) {
		t.Errorf("body = %s", req.Body)
	}
	// JSON mode passes the server document through without an envelope.
	var doc map[string]any
	if json.Unmarshal([]byte(out), &doc) != nil || doc["state"] != "paused" {
		t.Errorf("json passthrough: %s", out)
	}
}

func TestAPICommandForwardsDelete(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"DELETE /api/v1/widgets/w-1": {status: 200, body: `{"deleted": true}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "api", "delete", "/api/v1/widgets/w-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := rec.find("DELETE", "/api/v1/widgets/w-1"); !ok {
		t.Fatalf("DELETE never reached the server: %v", rec.lines())
	}
	if !strings.Contains(out, "deleted") || !strings.Contains(out, "true") {
		t.Errorf("delete summary: %s", out)
	}
}

func TestAPICommandRendersArrayResponseAsRows(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/widgets": {body: `[{"id": "w-1"}, {"id": "w-2"}]`},
	})
	out, err := runCLI(t, srv, "api", "get", "/api/v1/widgets")
	if err != nil {
		t.Fatal(err)
	}
	// The table view numbers each array element and prints its JSON.
	if !strings.Contains(out, `"id":"w-1"`) || !strings.Contains(out, `"id":"w-2"`) {
		t.Errorf("array rows missing:\n%s", out)
	}
}

func TestAPICommandJSONModeIndentsRawObject(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/overview": {body: `{"sessions":12,"agents":3}`},
	})
	out, err := runCLI(t, srv, "api", "get", "/api/v1/overview", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	// printIndented pretty-prints, so the compact server body gains indentation
	// and stays a bare object (no items/total envelope).
	if !strings.Contains(out, "  \"sessions\": 12") {
		t.Errorf("indented output expected:\n%s", out)
	}
	if strings.Contains(out, "\"items\"") || strings.Contains(out, "\"page_size\"") {
		t.Errorf("api json must not wrap objects in a list envelope:\n%s", out)
	}
}

func TestAPICommandForwardsQueryParamsOnGet(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/sessions": {body: `[]`},
	})
	recEnv(t, rec)
	if _, err := captureCLI(t, "api", "get", "/api/v1/sessions",
		"--param", "limit=5", "--param", "platform=kiro"); err != nil {
		t.Fatal(err)
	}
	req, ok := rec.find("GET", "/api/v1/sessions")
	if !ok {
		t.Fatalf("GET never reached the server: %v", rec.lines())
	}
	if !strings.Contains(req.Query, "limit=5") || !strings.Contains(req.Query, "platform=kiro") {
		t.Errorf("query = %s", req.Query)
	}
}
