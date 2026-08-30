// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

const publishAgentUUID = "33333333-4444-5555-6666-777777777777"

// initAgentDir writes a valid agent definition into a fresh directory.
func initPublishAgentDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	_, err := captureCLI(t, "agent", "init", "--dir", dir,
		"--name", "reviewer", "--description", "Reviews code",
		"--prompt", "Do the review", "--harness", "claude-code")
	if err != nil {
		t.Fatalf("agent init failed: %v", err)
	}
	return dir
}

func TestAgentPublishPayloadDefaults(t *testing.T) {
	doc := newOmap()
	doc.set("name", "reviewer")
	payload := agentPublishPayload(doc)
	if payload.str("version") != "1.0.0" {
		t.Errorf("default version = %q", payload.str("version"))
	}
	if payload.str("model_name") != "claude-sonnet-4" {
		t.Errorf("default model = %q", payload.str("model_name"))
	}
	comps, ok := payload.get("components").([]any)
	if !ok || len(comps) != 0 {
		t.Errorf("components must default to empty slice: %v", payload.get("components"))
	}
	if _, ok := payload.get("models_by_harness").(*omap); !ok {
		t.Errorf("models_by_harness must default to an omap")
	}
}

func TestAgentPublishSubmitsNew(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/agents": {body: `{"id": "ag1", "status": "pending"}`},
	})
	recEnv(t, rec)
	dir := initPublishAgentDir(t)
	out, err := captureCLI(t, "agent", "publish", "--dir", dir, "-o", "json")
	if err != nil {
		t.Fatalf("publish failed: %v", err)
	}
	if !strings.Contains(out, "ag1") {
		t.Errorf("response not passed through:\n%s", out)
	}
	req, ok := rec.find("POST", "/api/v1/agents")
	if !ok {
		t.Fatal("agent POST not recorded")
	}
	if !strings.Contains(req.Body, "reviewer") {
		t.Errorf("payload missing name: %s", req.Body)
	}
}

func TestAgentPublishDraft(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/agents/draft": {body: `{"id": "dr1"}`},
	})
	recEnv(t, rec)
	dir := initPublishAgentDir(t)
	out, err := captureCLI(t, "agent", "publish", "--dir", dir, "--draft")
	if err != nil {
		t.Fatalf("draft publish failed: %v", err)
	}
	if !strings.Contains(out, "Draft saved!") {
		t.Errorf("draft message missing:\n%s", out)
	}
	if _, ok := rec.find("POST", "/api/v1/agents/draft"); !ok {
		t.Error("draft POST not recorded")
	}
}

func TestAgentPublishUpdate(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/agents":     {body: `[{"id": "ag9", "name": "reviewer"}]`},
		"PUT /api/v1/agents/ag9": {body: `{"id": "ag9", "version": "1.0.1"}`},
	})
	recEnv(t, rec)
	dir := initPublishAgentDir(t)
	out, err := captureCLI(t, "agent", "publish", "--dir", dir, "--update", "--bump", "patch", "-o", "json")
	if err != nil {
		t.Fatalf("update publish failed: %v", err)
	}
	if !strings.Contains(out, "1.0.1") {
		t.Errorf("response not passed through:\n%s", out)
	}
	req, ok := rec.find("PUT", "/api/v1/agents/ag9")
	if !ok {
		t.Fatal("agent PUT not recorded")
	}
	if !strings.Contains(req.Body, "version_bump_type") {
		t.Errorf("bump not sent: %s", req.Body)
	}
}

func TestAgentPublishSubmitDraftReference(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/agents/" + publishAgentUUID + "/submit": {body: `{"id": "` + publishAgentUUID + `"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "agent", "publish", "--submit", publishAgentUUID)
	if err != nil {
		t.Fatalf("submit draft failed: %v", err)
	}
	if !strings.Contains(out, "Draft submitted for review!") {
		t.Errorf("submit message missing:\n%s", out)
	}
}

func TestAgentPublishDraftSubmitConflict(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{})
	recEnv(t, rec)
	_, err := captureCLI(t, "agent", "publish", "--draft", "--submit", publishAgentUUID)
	cerr := asCLIError(t, err)
	if !strings.Contains(cerr.Message, "--draft and --submit") {
		t.Errorf("expected draft/submit conflict: %s", cerr.Message)
	}
}

func TestAgentPublishBadBump(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{})
	recEnv(t, rec)
	_, err := captureCLI(t, "agent", "publish", "--bump", "huge")
	cerr := asCLIError(t, err)
	if !strings.Contains(cerr.Message, "Unknown version bump") {
		t.Errorf("expected bump rejection: %s", cerr.Message)
	}
}

func TestAgentReleaseFlow(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/agents/" + publishAgentUUID:                          {body: `{"id": "` + publishAgentUUID + `"}`},
		"GET /api/v1/agents/" + publishAgentUUID + "/version-suggestions": {body: `{"suggestions": {"minor": "1.1.0"}}`},
		"POST /api/v1/agents/" + publishAgentUUID + "/versions":           {body: `{"version": "1.1.0"}`},
	})
	recEnv(t, rec)
	dir := initPublishAgentDir(t)
	out, err := captureCLI(t, "agent", "release", publishAgentUUID, "--dir", dir, "--bump", "minor", "-o", "json")
	if err != nil {
		t.Fatalf("release failed: %v", err)
	}
	if !strings.Contains(out, "1.1.0") {
		t.Errorf("response not passed through:\n%s", out)
	}
	req, ok := rec.find("POST", "/api/v1/agents/"+publishAgentUUID+"/versions")
	if !ok {
		t.Fatal("version POST not recorded")
	}
	if !strings.Contains(req.Body, "yaml_snapshot") {
		t.Errorf("payload missing yaml snapshot: %s", req.Body)
	}
}

func TestAgentReleaseRequiresBump(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{})
	recEnv(t, rec)
	_, err := captureCLI(t, "agent", "release", publishAgentUUID)
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Usage {
		t.Errorf("category = %s", cerr.Category)
	}
}
